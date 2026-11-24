package main

import (
	"context"
	"sync"
)

// chunkPool is the layer's one counted memory budget: fixed-size chunks, never more than max.
// Every retained answer byte and every pump's read buffer lives in a chunk from here.
type chunkPool struct {
	mu        sync.Mutex
	changed   chan struct{}
	free      [][]byte
	allocated int
	max       int
	size      int
}

func newChunkPool(size, max int) *chunkPool {
	return &chunkPool{size: size, max: max, changed: make(chan struct{})}
}

// tryAcquire returns a chunk, or nil when the budget is spent.
func (p *chunkPool) tryAcquire() []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	if n := len(p.free); n > 0 {
		chunk := p.free[n-1]
		p.free = p.free[:n-1]
		return chunk
	}
	if p.allocated >= p.max {
		return nil
	}
	p.allocated++
	return make([]byte, p.size)
}

func (p *chunkPool) release(chunk []byte) {
	if chunk == nil {
		return
	}
	p.mu.Lock()
	p.free = append(p.free, chunk[:p.size])
	close(p.changed)
	p.changed = make(chan struct{})
	p.mu.Unlock()
}

// released returns a channel closed by the next release, so a waiter wakes on freed memory.
func (p *chunkPool) released() <-chan struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.changed
}

func (p *chunkPool) inUse() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.allocated - len(p.free)
}

// acquire waits for a chunk, first freeing already-written bytes through evict. It never fails a
// call for memory: when nothing can be freed it waits, which is backpressure on that upstream.
func (p *chunkPool) acquire(ctx context.Context, evict func() bool) ([]byte, error) {
	for {
		if chunk := p.tryAcquire(); chunk != nil {
			return chunk, nil
		}
		wait := p.released()
		if chunk := p.tryAcquire(); chunk != nil {
			return chunk, nil
		}
		if evict() {
			continue
		}
		select {
		case <-wait:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
}
