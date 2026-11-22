package main

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

type callState int

const (
	stateLive callState = iota
	stateComplete
	stateFailed
)

func (s callState) name() string {
	return [...]string{"live", "complete", "failed"}[s]
}

// call is one buffered answer. Offsets count raw answer bytes. Bytes at or after the write
// position (sent) are unsent and never dropped; bytes behind it are kept for resume up to the
// retain window, and may be freed under the pool limit.
type call struct {
	id     string
	store  *Store
	cancel func()

	mu      sync.Mutex
	wake    chan struct{}
	chunks  [][]byte
	base    int64 // offset of chunks[0]
	end     int64 // bytes read from the upstream
	sent    int64 // the current reader's write position
	state   callState
	dropped bool
	gen     int
	reader  bool
	writing int
	status  int
	header  http.Header
	idle    *time.Timer
	ended   time.Time
}

func newCall(s *Store, id string, cancel func()) *call {
	return &call{id: id, store: s, cancel: cancel, wake: make(chan struct{})}
}

func (c *call) changedLocked() {
	close(c.wake)
	c.wake = make(chan struct{})
}

func (c *call) size() int { return c.store.limits.chunk }

// begin attaches the original caller as reader 1.
func (c *call) begin(status int, header http.Header) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.status, c.header = status, header
	c.gen, c.reader = 1, true
	return c.gen
}

// pump keeps reading the upstream whether or not anyone reads, pausing while the unsent backlog
// fills the retain window.
func (c *call) pump(ctx context.Context, body io.ReadCloser) {
	defer body.Close()
	pool := c.store.pool
	scratch, err := pool.acquire(ctx, c.store.evictWritten)
	if err != nil {
		c.finish(stateFailed)
		return
	}
	defer pool.release(scratch)
	size, retain := c.size(), int64(c.store.limits.retain)
	for {
		c.mu.Lock()
		for !c.dropped && ctx.Err() == nil && c.end-c.sent >= retain {
			wait := c.wake
			c.mu.Unlock()
			select {
			case <-wait:
			case <-ctx.Done():
			}
			c.mu.Lock()
		}
		if c.dropped || ctx.Err() != nil {
			c.mu.Unlock()
			c.finish(stateFailed)
			return
		}
		needChunk := c.end == c.base+int64(len(c.chunks)*size)
		c.mu.Unlock()
		if needChunk {
			chunk, err := pool.acquire(ctx, c.store.evictWritten)
			if err != nil {
				c.finish(stateFailed)
				return
			}
			c.mu.Lock()
			if c.dropped {
				c.mu.Unlock()
				pool.release(chunk)
				continue
			}
			c.chunks = append(c.chunks, chunk)
			c.mu.Unlock()
		}
		c.mu.Lock()
		used := int(c.end-c.base) - (len(c.chunks)-1)*size
		c.mu.Unlock()
		n, readErr := body.Read(scratch[:size-used])
		if n > 0 {
			c.mu.Lock()
			if !c.dropped {
				copy(c.chunks[len(c.chunks)-1][used:], scratch[:n])
				c.end += int64(n)
				c.changedLocked()
			}
			c.mu.Unlock()
		}
		if readErr == io.EOF {
			c.finish(stateComplete)
			return
		}
		if readErr != nil {
			c.finish(stateFailed)
			return
		}
	}
}

func (c *call) finish(state callState) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.state == stateLive {
		c.state, c.ended = state, time.Now()
	}
	if c.state == stateFailed {
		// A failed answer is never resumed, so its bytes serve nobody.
		c.releaseLocked()
	}
	c.changedLocked()
}

// serve writes from the write position to w until the answer ends, the caller leaves, or a newer
// reader takes over. nil means the whole answer was written and the upstream ended normally.
func (c *call) serve(ctx context.Context, w http.ResponseWriter, gen int) error {
	flusher := http.NewResponseController(w)
	stop := context.AfterFunc(ctx, func() {
		c.mu.Lock()
		c.changedLocked()
		c.mu.Unlock()
	})
	defer stop()
	size := c.size()
	for {
		c.mu.Lock()
		for c.gen == gen && !c.dropped && ctx.Err() == nil && c.sent == c.end && c.state == stateLive {
			wait := c.wake
			c.mu.Unlock()
			<-wait
			c.mu.Lock()
		}
		switch {
		case c.gen != gen:
			c.mu.Unlock()
			return errStale
		case c.dropped:
			c.mu.Unlock()
			return errDropped
		case ctx.Err() != nil:
			c.mu.Unlock()
			return ctx.Err()
		}
		if c.sent < c.end && len(c.chunks) > 0 {
			index := int(c.sent-c.base) / size
			from := int(c.sent-c.base) - index*size
			to := size
			if index == len(c.chunks)-1 {
				to = int(c.end-c.base) - index*size
			}
			view := c.chunks[index][from:to]
			c.writing++
			c.mu.Unlock()
			n, err := w.Write(view)
			if err == nil {
				err = flusher.Flush()
			}
			c.mu.Lock()
			c.writing--
			if c.gen == gen {
				c.sent += int64(n)
				c.trimLocked()
				c.changedLocked()
			}
			if c.dropped && c.writing == 0 {
				c.releaseLocked()
			}
			c.mu.Unlock()
			if err != nil {
				return err
			}
			continue
		}
		state := c.state
		c.mu.Unlock()
		if state == stateComplete {
			return nil
		}
		return errFailed
	}
}

// trimLocked frees whole chunks older than the retain window behind the write position.
func (c *call) trimLocked() {
	size, keepFrom := int64(c.size()), c.sent-int64(c.store.limits.retain)
	for len(c.chunks) > 0 && c.base+size <= keepFrom && c.writing == 0 {
		c.store.pool.release(c.chunks[0])
		c.chunks, c.base = c.chunks[1:], c.base+size
	}
}

func (c *call) releaseLocked() {
	if c.writing > 0 {
		return
	}
	for _, chunk := range c.chunks {
		c.store.pool.release(chunk)
	}
	c.chunks, c.base = nil, c.end
}

func (c *call) evictionView() (finished bool, ended time.Time, written int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.state != stateLive, c.ended, int(c.sent-c.base) / c.size()
}

// freeWritten frees the oldest written chunk, if any; the chunk holding the write position stays.
func (c *call) freeWritten() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	size := int64(c.size())
	if len(c.chunks) == 0 || c.base+size > c.sent || c.writing > 0 {
		return false
	}
	c.store.pool.release(c.chunks[0])
	c.chunks, c.base = c.chunks[1:], c.base+size
	return true
}

// attach makes a resume read the only reader, from offset from.
func (c *call) attach(from int64) (int, callState, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case c.dropped:
		return 0, 0, errGone
	case c.state == stateFailed:
		return 0, 0, errFailed
	case from < c.base || from > c.end:
		return 0, 0, errGone
	}
	if c.idle != nil {
		c.idle.Stop()
	}
	c.gen++
	c.sent, c.reader = from, true
	c.changedLocked()
	return c.gen, c.state, nil
}

// detach starts the idle limit once the current reader has gone.
func (c *call) detach(gen int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.gen != gen || !c.reader {
		return
	}
	c.reader = false
	if c.idle == nil {
		c.idle = time.AfterFunc(c.store.limits.idle, c.expire)
	} else {
		c.idle.Reset(c.store.limits.idle)
	}
}

// expire drops a buffer nobody read for the idle limit and cancels its upstream, so an answer the
// client abandoned stops billing.
func (c *call) expire() {
	c.mu.Lock()
	if c.reader || c.dropped {
		c.mu.Unlock()
		return
	}
	c.dropped = true
	c.releaseLocked()
	c.changedLocked()
	c.mu.Unlock()
	c.cancel()
	c.store.remove(c)
}
