package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

// hopHeaders are connection-scoped (RFC 9110 section 7.6.1) and never cross the layer.
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// newUpstreamTransport opens one connection per call. The legacy drain counts every
// non-listening socket on the node's port, so an idle pooled connection would hold a
// drain open forever. Compression stays off so the body bytes are the node's own.
func newUpstreamTransport() *http.Transport {
	return &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second}).DialContext,
		DisableKeepAlives:     true,
		DisableCompression:    true,
		ForceAttemptHTTP2:     false,
		ResponseHeaderTimeout: 0,
	}
}

func stripHop(header http.Header) {
	for _, value := range header.Values("Connection") {
		for _, name := range strings.Split(value, ",") {
			if name = textproto.TrimString(name); name != "" {
				header.Del(name)
			}
		}
	}
	for _, name := range hopHeaders {
		header.Del(name)
	}
}

func upstreamRequest(ctx context.Context, upstream *url.URL, in *http.Request) (*http.Request, error) {
	target := *upstream
	target.Path, target.RawPath, target.RawQuery = in.URL.Path, in.URL.RawPath, in.URL.RawQuery
	body := in.Body
	if in.ContentLength == 0 {
		body = http.NoBody
	}
	out, err := http.NewRequestWithContext(ctx, in.Method, target.String(), body)
	if err != nil {
		return nil, err
	}
	out.ContentLength = in.ContentLength
	out.Header = in.Header.Clone()
	stripHop(out.Header)
	// An absent User-Agent stays absent; the client would otherwise add its own.
	if _, ok := out.Header["User-Agent"]; !ok {
		out.Header["User-Agent"] = []string{""}
	}
	out.Host = in.Host
	return out, nil
}

// writeHead copies the upstream status and headers and announces its trailers.
func writeHead(w http.ResponseWriter, resp *http.Response) {
	header := w.Header()
	for name, values := range resp.Header {
		header[name] = append([]string(nil), values...)
	}
	stripHop(header)
	for name := range resp.Trailer {
		header.Add("Trailer", name)
	}
	w.WriteHeader(resp.StatusCode)
}

// copyBody streams bytes as they arrive; a model stream must never wait for a full buffer.
func copyBody(w http.ResponseWriter, body io.Reader) error {
	flusher := http.NewResponseController(w)
	buffer := make([]byte, 32<<10)
	for {
		n, readErr := body.Read(buffer)
		if n > 0 {
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return writeErr
			}
			if flushErr := flusher.Flush(); flushErr != nil {
				return flushErr
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

func writeTrailers(w http.ResponseWriter, resp *http.Response) {
	for name, values := range resp.Trailer {
		w.Header()[http.TrailerPrefix+name] = append([]string(nil), values...)
	}
}

// passThrough forwards one call unchanged and unbuffered. The caller leaving cancels the upstream,
// as a direct call to the node does today.
func (l *Layer) passThrough(w http.ResponseWriter, r *http.Request) {
	out, err := upstreamRequest(r.Context(), l.upstream, r)
	if err != nil {
		closedError(w, http.StatusBadRequest, "resume_layer_bad_request")
		return
	}
	resp, err := l.transport.RoundTrip(out)
	if err != nil {
		// No byte reached the caller: the controller treats this like a refused node connection.
		w.Header().Set(upstreamStateHeader, "unreachable")
		closedError(w, http.StatusBadGateway, "resume_layer_upstream_unreachable")
		return
	}
	defer resp.Body.Close()
	writeHead(w, resp)
	if err := copyBody(w, resp.Body); err != nil {
		// Abort, never a clean end, so a cut answer can't pass for a complete one.
		panic(http.ErrAbortHandler)
	}
	writeTrailers(w, resp)
}
