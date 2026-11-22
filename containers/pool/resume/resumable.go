package main

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// canonicalID is the lowercase 8-4-4-4-12 form crypto.randomUUID produces.
var canonicalID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// resumable buffers a marked call. The upstream runs on its own context so it outlives the caller;
// only the idle limit cancels it.
func (l *Layer) resumable(w http.ResponseWriter, r *http.Request) {
	id := r.Header.Get(requestIDHeader)
	if !canonicalID.MatchString(id) {
		l.passThrough(w, r)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c, err := l.store.reserve(id, cancel)
	if err != nil {
		cancel()
		l.passThrough(w, r)
		return
	}
	out, err := upstreamRequest(ctx, l.upstream, r)
	if err != nil {
		l.abandon(c)
		closedError(w, http.StatusBadRequest, "resume_layer_bad_request")
		return
	}
	resp, err := l.transport.RoundTrip(out)
	if err != nil {
		l.abandon(c)
		upstreamFailure(w, err)
		return
	}
	if resp.StatusCode/100 != 2 {
		// Only a successful answer is worth resuming; anything else passes through as it is. Its
		// body is still read on the upstream context, so that context ends only with this call.
		l.store.remove(c)
		defer cancel()
		defer resp.Body.Close()
		stop := context.AfterFunc(r.Context(), cancel)
		defer stop()
		writeHead(w, resp)
		if err := copyBody(w, resp.Body); err != nil {
			panic(http.ErrAbortHandler)
		}
		writeTrailers(w, resp)
		return
	}
	gen := c.begin(resp.StatusCode, resp.Header.Clone())
	go c.pump(ctx, resp.Body)
	w.Header().Set(resumeHeader, "v1")
	writeHead(w, resp)
	err = c.serve(r.Context(), w, gen)
	c.detach(gen)
	if err != nil {
		panic(http.ErrAbortHandler)
	}
}

func (l *Layer) abandon(c *call) {
	c.cancel()
	l.store.remove(c)
}

// resume serves GET /__basalt/resume/v1/{id} from X-Basalt-Resume-From.
func (l *Layer) resume(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		closedError(w, http.StatusMethodNotAllowed, "resume_layer_method")
		return
	}
	id := strings.TrimPrefix(r.URL.Path, resumePrefix)
	from, err := strconv.ParseInt(r.Header.Get(resumeFromHeader), 10, 64)
	if !canonicalID.MatchString(id) || err != nil || from < 0 {
		closedError(w, http.StatusBadRequest, "resume_layer_bad_resume")
		return
	}
	c := l.store.lookup(id)
	if c == nil || l.boot == "" || r.Header.Get(resumeBootHeader) != l.boot {
		gone(w, "gone")
		return
	}
	gen, state, err := c.attach(from)
	if errors.Is(err, errFailed) {
		gone(w, "failed")
		return
	}
	if err != nil {
		gone(w, "gone")
		return
	}
	header := w.Header()
	if contentType := c.header.Values("Content-Type"); len(contentType) > 0 {
		header["Content-Type"] = contentType
	} else {
		header["Content-Type"] = nil
	}
	header.Set(resumeHeader, "v1")
	header.Set(resumeFromHeader, strconv.FormatInt(from, 10))
	header.Set(resumeStateHeader, state.name())
	header.Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_ = http.NewResponseController(w).Flush()
	err = c.serve(r.Context(), w, gen)
	c.detach(gen)
	if err != nil {
		// A failed upstream, a newer reader or a dropped buffer: never a clean end.
		panic(http.ErrAbortHandler)
	}
}

func gone(w http.ResponseWriter, state string) {
	w.Header().Set(resumeStateHeader, state)
	closedError(w, http.StatusGone, "resume_gone")
}
