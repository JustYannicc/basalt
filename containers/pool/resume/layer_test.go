package main

import (
	"bufio"
	"bytes"
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type upstreamFixture struct {
	server *httptest.Server
	open   atomic.Int64
	seen   chan *http.Request
	bodies chan []byte
}

func newUpstream(t *testing.T, handler http.HandlerFunc) *upstreamFixture {
	t.Helper()
	fixture := &upstreamFixture{seen: make(chan *http.Request, 8), bodies: make(chan []byte, 8)}
	fixture.server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fixture.seen <- r.Clone(r.Context())
		fixture.bodies <- body
		handler(w, r)
	}))
	fixture.server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		switch state {
		case http.StateNew:
			fixture.open.Add(1)
		case http.StateClosed, http.StateHijacked:
			fixture.open.Add(-1)
		}
	}
	fixture.server.Start()
	t.Cleanup(fixture.server.Close)
	return fixture
}

func newLayerServer(t *testing.T, upstream *upstreamFixture) *httptest.Server {
	t.Helper()
	target, err := url.Parse(upstream.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(NewLayer(target, NewStore(testLimits()), testBoot))
	t.Cleanup(server.Close)
	return server
}

// rawCall sends exact request bytes, so nothing a Go client adds can hide what the layer changed.
func rawCall(t *testing.T, address string, request string) (*http.Response, []byte) {
	t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(address, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	if _, err := io.WriteString(conn, request); err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp, body
}

func TestPassThroughKeepsRequestAndAnswerBytes(t *testing.T) {
	answer := []byte("event: message_start\ndata: {\"a\":1}\n\n\x1f\x8bnot-really-gzip")
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("X-Upstream", "kept")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write(answer)
	})
	layer := newLayerServer(t, upstream)
	payload := `{"model":"m","stream":true}`
	resp, body := rawCall(t, layer.URL, "POST /v1/messages?beta=true HTTP/1.1\r\n"+
		"Host: pool\r\nX-Forwarded-For: 203.0.113.9\r\nX-Basalt-Request-Id: 6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f\r\n"+
		"Content-Type: application/json\r\nConnection: keep-alive, X-Hop\r\nX-Hop: drop\r\n"+
		"Content-Length: "+strconv.Itoa(len(payload))+"\r\n\r\n"+payload)

	got := <-upstream.seen
	if got.URL.RequestURI() != "/v1/messages?beta=true" || got.Method != http.MethodPost || got.Host != "pool" {
		t.Fatalf("upstream saw %s %s host %q", got.Method, got.URL.RequestURI(), got.Host)
	}
	if string(<-upstream.bodies) != payload {
		t.Fatal("request body changed")
	}
	for name, want := range map[string]string{
		"X-Forwarded-For": "203.0.113.9", "X-Basalt-Request-Id": "6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f",
		"User-Agent": "", "Accept-Encoding": "", "X-Hop": "",
	} {
		if value := got.Header.Get(name); value != want {
			t.Fatalf("upstream header %s = %q, want %q", name, value, want)
		}
	}
	if resp.StatusCode != http.StatusCreated || !bytes.Equal(body, answer) {
		t.Fatalf("answer changed: %d %q", resp.StatusCode, body)
	}
	if resp.Header.Get("Content-Encoding") != "gzip" || resp.Header.Get("X-Upstream") != "kept" {
		t.Fatalf("answer headers changed: %v", resp.Header)
	}
}

func TestMarkedCallIsOfferedForResumeAndTheMarkerStopsAtTheLayer(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	layer := newLayerServer(t, upstream)
	resp, body := rawCall(t, layer.URL, "POST /v1/messages HTTP/1.1\r\nHost: pool\r\n"+
		"X-Basalt-Resumable: 1\r\nX-Basalt-Request-Id: 6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f\r\nContent-Length: 0\r\n\r\n")
	if string(body) != "ok" || resp.Header.Get(resumeHeader) != "v1" {
		t.Fatalf("marked call: %q resume=%q", body, resp.Header.Get(resumeHeader))
	}
	seen := <-upstream.seen
	if seen.Header.Get(resumableHeader) != "" || seen.Header.Get(requestIDHeader) == "" {
		t.Fatalf("node saw marker %q and id %q", seen.Header.Get(resumableHeader), seen.Header.Get(requestIDHeader))
	}
}

func TestAnswerStreamsBeforeTheUpstreamFinishes(t *testing.T) {
	release := make(chan struct{})
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: first\n\n"))
		w.(http.Flusher).Flush()
		<-release
		_, _ = w.Write([]byte("data: last\n\n"))
	})
	layer := newLayerServer(t, upstream)
	resp, err := http.Post(layer.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	first := make([]byte, len("data: first\n\n"))
	done := make(chan error, 1)
	go func() { _, err := io.ReadFull(resp.Body, first); done <- err }()
	select {
	case err := <-done:
		if err != nil || string(first) != "data: first\n\n" {
			t.Fatalf("first event: %q %v", first, err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the first event waited for the end of the answer")
	}
	close(release)
	rest, _ := io.ReadAll(resp.Body)
	if string(rest) != "data: last\n\n" {
		t.Fatalf("rest: %q", rest)
	}
}

func TestNoIdleConnectionToTheNodeOutlivesACall(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("ok")) })
	layer := newLayerServer(t, upstream)
	for range 3 {
		resp, err := http.Get(layer.URL + "/v1/models")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
	}
	deadline := time.Now().Add(5 * time.Second)
	for upstream.open.Load() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%d connections to the node stayed open; the legacy drain would count them", upstream.open.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCallerLeavingCancelsAnUnmarkedUpstream(t *testing.T) {
	cancelled := make(chan struct{})
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("data: x\n\n"))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
		close(cancelled)
	})
	layer := newLayerServer(t, upstream)
	resp, err := http.Get(layer.URL + "/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = resp.Body.Read(make([]byte, 4))
	resp.Body.Close()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the node kept serving a call nobody reads")
	}
}

func TestUpstreamCutAbortsInsteadOfEndingCleanly(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", "100")
		_, _ = w.Write([]byte("partial"))
		w.(http.Flusher).Flush()
		conn, _, _ := http.NewResponseController(w).Hijack()
		_ = conn.Close()
	})
	layer := newLayerServer(t, upstream)
	resp, err := http.Get(layer.URL + "/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("a cut answer ended like a complete one")
	}
}

func TestNoHeaderTheNodeDidNotSend(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header()["Content-Type"] = nil
		_, _ = w.Write([]byte("<html>plain bytes</html>"))
	})
	layer := newLayerServer(t, upstream)
	direct, _ := rawCall(t, upstream.server.URL, "GET /v1/models HTTP/1.1\r\nHost: pool\r\n\r\n")
	through, _ := rawCall(t, layer.URL, "GET /v1/models HTTP/1.1\r\nHost: pool\r\n\r\n")
	for name := range through.Header {
		if name != "Date" && name != "Content-Length" && direct.Header.Get(name) != through.Header.Get(name) {
			t.Fatalf("header %s: direct %q, through the layer %q", name, direct.Header.Get(name), through.Header.Get(name))
		}
	}
}

func TestTrailersPassThrough(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Trailer", "X-Final")
		_, _ = w.Write([]byte("body"))
		w.Header().Set("X-Final", "done")
	})
	layer := newLayerServer(t, upstream)
	resp, err := http.Get(layer.URL + "/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.Trailer.Get("X-Final") != "done" {
		t.Fatalf("trailer lost: %v", resp.Trailer)
	}
}

func TestSocketsAndResumeReadsNeverReachTheNode(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	layer := newLayerServer(t, upstream)
	upgrade, _ := rawCall(t, layer.URL, "GET /v1/responses HTTP/1.1\r\nHost: pool\r\n"+
		"Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n")
	if upgrade.StatusCode != http.StatusBadRequest {
		t.Fatalf("upgrade answered %d", upgrade.StatusCode)
	}
	gone, _ := rawCall(t, layer.URL, "GET "+resumePrefix+"6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f HTTP/1.1\r\nHost: pool\r\n"+
		resumeFromHeader+": 10\r\n"+resumeBootHeader+": b\r\n\r\n")
	if gone.StatusCode != http.StatusGone || gone.Header.Get(resumeStateHeader) != "gone" {
		t.Fatalf("resume of an unknown id answered %d state %q", gone.StatusCode, gone.Header.Get(resumeStateHeader))
	}
	health, body := rawCall(t, layer.URL, "GET "+healthPath+" HTTP/1.1\r\nHost: pool\r\n\r\n")
	if health.StatusCode != http.StatusOK || string(body) != `{"status":"ok"}` {
		t.Fatalf("health: %d %s", health.StatusCode, body)
	}
	select {
	case r := <-upstream.seen:
		t.Fatalf("the node received %s %s", r.Method, r.URL.Path)
	default:
	}
}

func TestUnreachableNodeIsNamedBeforeAnyAnswerByte(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	target, _ := url.Parse("http://" + address)
	layer := httptest.NewServer(NewLayer(target, NewStore(testLimits()), testBoot))
	defer layer.Close()
	resp, err := http.Get(layer.URL + "/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || resp.Header.Get(upstreamStateHeader) != "unreachable" {
		t.Fatalf("unreachable node answered %d %q", resp.StatusCode, resp.Header.Get(upstreamStateHeader))
	}
}

func TestConcurrentPassThroughStaysIsolated(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.URL.Query().Get("n")))
	})
	upstream.seen, upstream.bodies = make(chan *http.Request, 64), make(chan []byte, 64)
	layer := newLayerServer(t, upstream)
	var wg sync.WaitGroup
	for i := range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			n := strconv.Itoa(i)
			resp, err := http.Get(layer.URL + "/v1/messages?n=" + n)
			if err != nil {
				t.Error(err)
				return
			}
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if string(body) != n {
				t.Errorf("call %s got %q", n, body)
			}
		}()
	}
	wg.Wait()
}

// acceptAndClose is a node that reads the call and closes without answering, as on a crash mid-call.
func acceptAndClose(t *testing.T) *url.URL {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			_, _ = http.ReadRequest(bufio.NewReader(conn))
			_ = conn.Close()
		}
	}()
	target, _ := url.Parse("http://" + listener.Addr().String())
	return target
}

func TestANodeThatFailsAfterAcceptingTheCallIsFailedNeverUnreachable(t *testing.T) {
	layer := httptest.NewServer(NewLayer(acceptAndClose(t), NewStore(testLimits()), testBoot))
	defer layer.Close()
	for name, marked := range map[string]bool{"unmarked": false, "marked": true} {
		req, _ := http.NewRequest(http.MethodPost, layer.URL+"/v1/messages", strings.NewReader("{}"))
		if marked {
			req.Header.Set(resumableHeader, "1")
			req.Header.Set(requestIDHeader, "6f1c2b8e-1d2a-4c3b-9e8f-0000000000a1")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadGateway || resp.Header.Get(upstreamStateHeader) != "failed" {
			t.Fatalf("%s: a node that took the call answered %d %q; a resend could run it twice",
				name, resp.StatusCode, resp.Header.Get(upstreamStateHeader))
		}
	}
}

func TestCallerLeavingBeforeTheHeadersCancelsAMarkedUpstream(t *testing.T) {
	cancelled := make(chan struct{})
	upstream := newUpstream(t, func(_ http.ResponseWriter, r *http.Request) {
		// A non-streaming answer: nothing is sent until the whole generation is done.
		<-r.Context().Done()
		close(cancelled)
	})
	layer := newLayerServer(t, upstream)
	ctx, cancel := context.WithCancel(context.Background())
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, layer.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set(resumableHeader, "1")
	request.Header.Set(requestIDHeader, "6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f")
	done := make(chan struct{})
	go func() {
		defer close(done)
		if resp, err := http.DefaultClient.Do(request); err == nil {
			resp.Body.Close()
		}
	}()
	<-upstream.seen
	cancel()
	select {
	case <-cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("a marked call kept running after its caller left before any answer")
	}
	<-done
	resume, _ := http.NewRequest(http.MethodGet, layer.URL+resumePrefix+"6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f", nil)
	resume.Header.Set(resumeFromHeader, "0")
	resume.Header.Set(resumeBootHeader, testBoot)
	resp, err := http.DefaultClient.Do(resume)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone || resp.Header.Get(resumeStateHeader) != "gone" {
		t.Fatalf("a call cancelled before its answer answered %d %q", resp.StatusCode, resp.Header.Get(resumeStateHeader))
	}
}

func TestTheNodesOwnResumeHeadersNeverReachTheController(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Basalt-Resume-Upstream", "unreachable")
		w.Header().Set("X-Basalt-Resume", "forged")
		_, _ = w.Write([]byte("ok"))
	})
	layer := newLayerServer(t, upstream)
	plain, _ := rawCall(t, layer.URL, "POST /v1/messages HTTP/1.1\r\nHost: pool\r\nContent-Length: 0\r\n\r\n")
	marked, _ := rawCall(t, layer.URL, "POST /v1/messages HTTP/1.1\r\nHost: pool\r\n"+
		"X-Basalt-Resumable: 1\r\nX-Basalt-Request-Id: 6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e60\r\nContent-Length: 0\r\n\r\n")
	for name, resp := range map[string]*http.Response{"pass-through": plain, "marked": marked} {
		if resp.Header.Get("X-Basalt-Resume-Upstream") != "" {
			t.Fatalf("%s: the node's unreachable header reached the controller", name)
		}
	}
	if plain.Header.Get(resumeHeader) != "" || marked.Header.Get(resumeHeader) != "v1" {
		t.Fatalf("resume headers: plain %q marked %q", plain.Header.Get(resumeHeader), marked.Header.Get(resumeHeader))
	}
}

func TestAMarkedCallAsksForIdentityAndAnEncodedAnswerIsNotResumable(t *testing.T) {
	upstream := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte("compressed"))
	})
	layer := newLayerServer(t, upstream)
	resp, _ := rawCall(t, layer.URL, "POST /v1/messages HTTP/1.1\r\nHost: pool\r\nAccept-Encoding: gzip\r\n"+
		"X-Basalt-Resumable: 1\r\nX-Basalt-Request-Id: 6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e61\r\nContent-Length: 0\r\n\r\n")
	if seen := <-upstream.seen; seen.Header.Get("Accept-Encoding") != "identity" {
		t.Fatalf("the node was asked for %q", seen.Header.Get("Accept-Encoding"))
	}
	if resp.Header.Get(resumeHeader) != "" {
		t.Fatal("an encoded answer was offered for resume")
	}
}
