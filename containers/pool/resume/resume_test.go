package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

const testBoot = "boot-test"

func testLimits() storeLimits {
	return storeLimits{chunk: 1 << 10, retain: 8 << 10, max: 64 << 10, idle: 200 * time.Millisecond}
}

// feed is an upstream the test drives: each value is written and flushed; closing ends the answer.
type feed struct {
	parts     chan []byte
	fail      chan struct{}
	cancelled chan struct{}
	once      sync.Once
}

func newFeed() *feed {
	return &feed{parts: make(chan []byte, 64), fail: make(chan struct{}), cancelled: make(chan struct{})}
}

// feeds gives every request id its own upstream answer.
type feeds struct {
	mu   sync.Mutex
	byID map[string]*feed
}

func (f *feeds) get(id string) *feed {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.byID[id] == nil {
		f.byID[id] = newFeed()
	}
	return f.byID[id]
}

func (f *feeds) handler(w http.ResponseWriter, r *http.Request) {
	f.get(r.Header.Get(requestIDHeader)).handler(w, r)
}

func (f *feed) handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	w.(http.Flusher).Flush()
	for {
		select {
		case part, ok := <-f.parts:
			if !ok {
				return
			}
			if _, err := w.Write(part); err != nil {
				return
			}
			w.(http.Flusher).Flush()
		case <-f.fail:
			conn, _, _ := http.NewResponseController(w).Hijack()
			_ = conn.Close()
			return
		case <-r.Context().Done():
			f.once.Do(func() { close(f.cancelled) })
			return
		}
	}
}

type resumeFixture struct {
	t     *testing.T
	feeds *feeds
	store *Store
	layer *httptest.Server
}

func newResumeFixture(t *testing.T, limits storeLimits) *resumeFixture {
	t.Helper()
	f := &feeds{byID: map[string]*feed{}}
	upstream := httptest.NewServer(http.HandlerFunc(f.handler))
	t.Cleanup(upstream.Close)
	target, _ := url.Parse(upstream.URL)
	store := NewStore(limits)
	layer := httptest.NewServer(NewLayer(target, store, testBoot))
	t.Cleanup(layer.Close)
	return &resumeFixture{t: t, feeds: f, store: store, layer: layer}
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return b
}

func testID(n int) string {
	return "6f1c2b8e-1d2a-4c3b-9e8f-" + strings.Repeat("0", 12-len(strconv.Itoa(n))) + strconv.Itoa(n)
}

// open sends a marked call over its own connection, returning the connection and its answer.
func (x *resumeFixture) open(id string) (net.Conn, *http.Response) {
	x.t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(x.layer.URL, "http://"))
	if err != nil {
		x.t.Fatal(err)
	}
	x.t.Cleanup(func() { _ = conn.Close() })
	_, _ = io.WriteString(conn, "POST /v1/messages HTTP/1.1\r\nHost: pool\r\n"+resumableHeader+": 1\r\n"+
		requestIDHeader+": "+id+"\r\nContent-Length: 0\r\n\r\n")
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	return conn, resp
}

func (x *resumeFixture) resume(id string, from int64, boot string) *http.Response {
	x.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, x.layer.URL+resumePrefix+id, nil)
	req.Header.Set(resumeFromHeader, strconv.FormatInt(from, 10))
	req.Header.Set(resumeBootHeader, boot)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		x.t.Fatal(err)
	}
	x.t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// waitDetached returns once the layer has seen the reader go. Until then its writer can still
// hand bytes to the closed socket, and those count as sent.
func (x *resumeFixture) waitDetached(id string) {
	x.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if c := x.store.lookup(id); c != nil {
			c.mu.Lock()
			reader := c.reader
			c.mu.Unlock()
			if !reader {
				return
			}
		}
		if time.Now().After(deadline) {
			x.t.Fatalf("the layer never saw the reader of %s go", id)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (x *resumeFixture) waitEnd(id string, atLeast int64) {
	x.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if c := x.store.lookup(id); c != nil {
			c.mu.Lock()
			end, state := c.end, c.state
			c.mu.Unlock()
			if end >= atLeast || state != stateLive {
				return
			}
		}
		if time.Now().After(deadline) {
			x.t.Fatalf("the layer never read %d bytes of %s", atLeast, id)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestResumeAfterTheReaderIsCutDeliversIdenticalBytes(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	answer := randomBytes(6000)
	id := testID(1)
	conn, resp := x.open(id)
	if resp.Header.Get(resumeHeader) != "v1" {
		t.Fatal("a marked call must be offered for resume")
	}
	x.feeds.get(id).parts <- answer[:3000]
	delivered := make([]byte, 1000)
	if _, err := io.ReadFull(resp.Body, delivered); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	x.feeds.get(id).parts <- answer[3000:]
	close(x.feeds.get(id).parts)
	x.waitEnd(id, int64(len(answer)))
	resumed := x.resume(id, 1000, testBoot)
	if resumed.StatusCode != http.StatusOK || resumed.Header.Get(resumeFromHeader) != "1000" ||
		resumed.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("resume answered %d from %q type %q", resumed.StatusCode, resumed.Header.Get(resumeFromHeader), resumed.Header.Get("Content-Type"))
	}
	rest, err := io.ReadAll(resumed.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(append(delivered, rest...), answer) {
		t.Fatal("the delivered and resumed bytes differ from the upstream's answer")
	}
}

func TestResumeOfARunningAnswerFollowsTheUpstreamLive(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(2)
	conn, resp := x.open(id)
	x.feeds.get(id).parts <- []byte("first")
	head := make([]byte, 5)
	_, _ = io.ReadFull(resp.Body, head)
	_ = conn.Close()
	resumed := x.resume(id, 5, testBoot)
	if resumed.Header.Get(resumeStateHeader) != "live" {
		t.Fatalf("state %q", resumed.Header.Get(resumeStateHeader))
	}
	x.feeds.get(id).parts <- []byte("-second")
	close(x.feeds.get(id).parts)
	rest, err := io.ReadAll(resumed.Body)
	if err != nil || string(rest) != "-second" {
		t.Fatalf("live resume got %q %v", rest, err)
	}
}

func TestAnAttachedSlowReaderNeverLosesAByte(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	answer := randomBytes(64 << 10) // eight retain windows
	id := testID(3)
	_, resp := x.open(id)
	go func() {
		for i := 0; i < len(answer); i += 3000 {
			x.feeds.get(id).parts <- answer[i:min(i+3000, len(answer))]
		}
		close(x.feeds.get(id).parts)
	}()
	first := make([]byte, 1)
	_, _ = io.ReadFull(resp.Body, first)
	time.Sleep(300 * time.Millisecond) // stall far past one window of output
	rest, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(append(first, rest...), answer) {
		t.Fatal("a slow attached reader lost or reordered bytes")
	}
	if inUse := x.store.pool.inUse(); inUse*testLimits().chunk > testLimits().max {
		t.Fatalf("pool over its limit: %d chunks", inUse)
	}
}

func TestNobodyReadingStopsTheUpstreamAtTheWindow(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(4)
	conn, _ := x.open(id)
	_ = conn.Close()
	go func() {
		for range 64 {
			x.feeds.get(id).parts <- randomBytes(1 << 10)
		}
	}()
	x.waitEnd(id, int64(testLimits().retain))
	time.Sleep(100 * time.Millisecond)
	c := x.store.lookup(id)
	c.mu.Lock()
	backlog := c.end - c.sent
	c.mu.Unlock()
	if backlog > int64(testLimits().retain+testLimits().chunk) {
		t.Fatalf("read %d unsent bytes past the %d window", backlog, testLimits().retain)
	}
}

func TestAnAbandonedUpstreamIsCancelledAndGoneAfterTheIdleLimit(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(5)
	conn, resp := x.open(id)
	x.feeds.get(id).parts <- []byte("partial")
	_, _ = io.ReadFull(resp.Body, make([]byte, 7))
	_ = conn.Close()
	select {
	case <-x.feeds.get(id).cancelled:
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream kept running after the idle limit")
	}
	if gone := x.resume(id, 7, testBoot); gone.StatusCode != http.StatusGone || gone.Header.Get(resumeStateHeader) != "gone" {
		t.Fatalf("after the idle limit resume answered %d %q", gone.StatusCode, gone.Header.Get(resumeStateHeader))
	}
}

func TestAFinishedAnswerIsGoneAfterTheIdleLimit(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(6)
	_, resp := x.open(id)
	close(x.feeds.get(id).parts)
	_, _ = io.ReadAll(resp.Body)
	time.Sleep(3 * testLimits().idle)
	if gone := x.resume(id, 0, testBoot); gone.StatusCode != http.StatusGone {
		t.Fatalf("finished answer still resumable: %d", gone.StatusCode)
	}
}

func TestOffsetsOutsideTheWindowBootsAndUnknownIdsAreGone(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	answer := randomBytes(32 << 10)
	id := testID(7)
	_, resp := x.open(id)
	x.feeds.get(id).parts <- answer
	close(x.feeds.get(id).parts)
	if got, _ := io.ReadAll(resp.Body); !bytes.Equal(got, answer) {
		t.Fatal("first read differs")
	}
	end := int64(len(answer))
	for name, from := range map[string]int64{"older than the window": 0, "beyond the answer": end + 1} {
		if r := x.resume(id, from, testBoot); r.StatusCode != http.StatusGone || r.Header.Get(resumeStateHeader) != "gone" {
			t.Fatalf("%s: %d", name, r.StatusCode)
		}
	}
	if r := x.resume(id, end, "other-boot"); r.StatusCode != http.StatusGone {
		t.Fatalf("another boot: %d", r.StatusCode)
	}
	if r := x.resume(testID(99), 0, testBoot); r.StatusCode != http.StatusGone {
		t.Fatalf("unknown id: %d", r.StatusCode)
	}
	inside := end - int64(testLimits().retain)/2
	r := x.resume(id, inside, testBoot)
	tail, _ := io.ReadAll(r.Body)
	if r.StatusCode != http.StatusOK || r.Header.Get(resumeStateHeader) != "complete" || !bytes.Equal(tail, answer[inside:]) {
		t.Fatalf("inside the window: %d %q", r.StatusCode, r.Header.Get(resumeStateHeader))
	}
}

func TestAnUpstreamFailureAbortsTheReaderAndLaterResumesAreFailed(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(8)
	_, resp := x.open(id)
	x.feeds.get(id).parts <- []byte("partial")
	_, _ = io.ReadFull(resp.Body, make([]byte, 7))
	close(x.feeds.get(id).fail)
	if _, err := io.ReadAll(resp.Body); err == nil {
		t.Fatal("a failed upstream ended the reader cleanly")
	}
	if r := x.resume(id, 7, testBoot); r.StatusCode != http.StatusGone || r.Header.Get(resumeStateHeader) != "failed" {
		t.Fatalf("resume after failure: %d %q", r.StatusCode, r.Header.Get(resumeStateHeader))
	}
}

func TestANewerReaderTakesOverAndTheOlderIsClosed(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(9)
	_, old := x.open(id)
	x.feeds.get(id).parts <- []byte("abc")
	_, _ = io.ReadFull(old.Body, make([]byte, 3))
	newer := x.resume(id, 0, testBoot)
	x.feeds.get(id).parts <- []byte("def")
	close(x.feeds.get(id).parts)
	got, err := io.ReadAll(newer.Body)
	if err != nil || string(got) != "abcdef" {
		t.Fatalf("newer reader got %q %v", got, err)
	}
	if _, err := io.ReadAll(old.Body); err == nil {
		t.Fatal("the replaced reader ended cleanly")
	}
}

func TestOnlyFreshCanonicalIdsAreBuffered(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(10)
	_, first := x.open(id)
	if first.Header.Get(resumeHeader) != "v1" {
		t.Fatal("first call not buffered")
	}
	_, repeated := x.open(id)
	if repeated.Header.Get(resumeHeader) != "" {
		t.Fatal("a repeated id was buffered twice")
	}
	_, upper := x.open(strings.ToUpper(testID(11)))
	if upper.Header.Get(resumeHeader) != "" {
		t.Fatal("a non-canonical id was buffered")
	}
}

func TestThePoolLimitFreesWrittenBytesAndNeverUnsentOnes(t *testing.T) {
	limits := testLimits()
	limits.max = 24 << 10 // three windows
	x := newResumeFixture(t, limits)
	for i := range 2 {
		id := testID(20 + i)
		_, resp := x.open(id)
		x.feeds.get(id).parts <- randomBytes(8 << 10)
		close(x.feeds.get(id).parts)
		_, _ = io.ReadAll(resp.Body)
	}
	id := testID(22)
	answer := randomBytes(48 << 10)
	_, resp := x.open(id)
	go func() {
		for i := 0; i < len(answer); i += 4096 {
			x.feeds.get(id).parts <- answer[i:min(i+4096, len(answer))]
		}
		close(x.feeds.get(id).parts)
	}()
	got, err := io.ReadAll(resp.Body)
	if err != nil || !bytes.Equal(got, answer) {
		t.Fatalf("the live reader lost bytes under the pool limit: %v", err)
	}
	if r := x.resume(testID(20), 0, testBoot); r.StatusCode != http.StatusGone {
		t.Fatalf("a finished call kept written bytes the pool needed: %d", r.StatusCode)
	}
}

func TestAnErrorAnswerPassesThroughWithoutResume(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate"}`))
	}))
	defer upstream.Close()
	x := &resumeFixture{t: t, store: NewStore(testLimits())}
	x.layer = httptest.NewServer(NewLayer(mustURL(t, upstream.URL), x.store, testBoot))
	defer x.layer.Close()
	_, resp := x.open(testID(30))
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get(resumeHeader) != "" || string(body) != `{"error":"rate"}` {
		t.Fatalf("error answer changed: %d %q %s", resp.StatusCode, resp.Header.Get(resumeHeader), body)
	}
	if x.store.lookup(testID(30)) != nil {
		t.Fatal("an error answer kept a buffer")
	}
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestAChunkedErrorAnswerArrivesWholeAndEndsCleanly(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":`))
		w.(http.Flusher).Flush()
		time.Sleep(100 * time.Millisecond)
		_, _ = w.Write([]byte(`"rate limited"}`))
	}))
	defer upstream.Close()
	x := &resumeFixture{t: t, store: NewStore(testLimits())}
	x.layer = httptest.NewServer(NewLayer(mustURL(t, upstream.URL), x.store, testBoot))
	defer x.layer.Close()
	_, resp := x.open(testID(31))
	body, err := io.ReadAll(resp.Body)
	if err != nil || string(body) != `{"error":"rate limited"}` {
		t.Fatalf("error answer cut: %q %v", body, err)
	}
}

func TestAResumeFromBeyondTheWritePositionIsGone(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(32)
	conn, resp := x.open(id)
	x.feeds.get(id).parts <- []byte("written")
	_, _ = io.ReadFull(resp.Body, make([]byte, 7))
	_ = conn.Close()
	x.waitDetached(id)
	x.feeds.get(id).parts <- []byte("-unsent")
	close(x.feeds.get(id).parts)
	x.waitEnd(id, 14)
	c := x.store.lookup(id)
	c.mu.Lock()
	sent, end := c.sent, c.end
	c.mu.Unlock()
	if sent >= end {
		t.Fatalf("setup: nothing unsent (sent %d end %d)", sent, end)
	}
	if r := x.resume(id, sent+1, testBoot); r.StatusCode != http.StatusGone {
		t.Fatalf("a resume past the write position answered %d", r.StatusCode)
	}
	if r := x.resume(id, sent, testBoot); r.StatusCode != http.StatusOK {
		t.Fatalf("a resume at the write position answered %d", r.StatusCode)
	}
}

func TestATakeoverClosesAReaderBlockedInWrite(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(21)
	_, old := x.open(id)
	feed := x.feeds.get(id)
	// The old reader never reads: once its socket is full, its Write blocks in the kernel.
	go func() {
		part := randomBytes(64 << 10)
		for i := 0; i < 128; i++ {
			select {
			case feed.parts <- part:
			case <-feed.cancelled:
				return
			}
		}
	}()
	c := x.store.lookup(id)
	deadline := time.Now().Add(5 * time.Second)
	var stuck int64
	for {
		c.mu.Lock()
		writing, sent := c.writing, c.sent
		c.mu.Unlock()
		if writing > 0 && sent == stuck && sent > 0 {
			break
		}
		stuck = sent
		if time.Now().After(deadline) {
			t.Fatal("the old reader never blocked in Write")
		}
		time.Sleep(100 * time.Millisecond)
	}
	newer := x.resume(id, stuck, testBoot)
	if newer.StatusCode != http.StatusOK {
		t.Fatalf("takeover answered %d", newer.StatusCode)
	}
	if _, err := io.ReadFull(newer.Body, make([]byte, 1<<10)); err != nil {
		t.Fatalf("the new reader got nothing: %v", err)
	}
	if _, err := io.ReadAll(old.Body); err == nil {
		t.Fatal("the reader blocked in Write was never closed")
	}
}

func TestAFinishedCallSentToItsEndGivesUpItsLastChunk(t *testing.T) {
	x := newResumeFixture(t, testLimits())
	id := testID(22)
	_, answer := x.open(id)
	feed := x.feeds.get(id)
	feed.parts <- []byte("short answer")
	close(feed.parts)
	if got, err := io.ReadAll(answer.Body); err != nil || string(got) != "short answer" {
		t.Fatalf("answer %q %v", got, err)
	}
	x.waitEnd(id, 12)
	c := x.store.lookup(id)
	if !x.store.evictWritten() {
		t.Fatal("a finished, fully sent call was not evictable")
	}
	c.mu.Lock()
	held := len(c.chunks)
	c.mu.Unlock()
	if held != 0 {
		t.Fatalf("a finished call sent to its end still holds %d chunks", held)
	}
	end := x.resume(id, 12, testBoot)
	if got, _ := io.ReadAll(end.Body); end.StatusCode != http.StatusOK || len(got) != 0 {
		t.Fatalf("a resume from the end answered %d with %d bytes", end.StatusCode, len(got))
	}
}

func TestNoResumeAttachesBeforeTheAnswerBegins(t *testing.T) {
	store := NewStore(testLimits())
	c, err := store.reserve(testID(23), func() {})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := c.attach(0); !errors.Is(err, errGone) {
		t.Fatalf("a resume before the node answered got %v, want gone", err)
	}
}
