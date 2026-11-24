package main

import (
	"errors"
	"sort"
	"sync"
	"time"
)

// Limits named by the #1642 contract (v1).
const (
	chunkBytes            = 64 << 10
	resumeRetainBytes     = 8 << 20
	resumeBuffersMaxBytes = 128 << 20
	resumeIdle            = 30 * time.Second
)

var (
	errHeld    = errors.New("request id already held")
	errGone    = errors.New("gone")
	errFailed  = errors.New("upstream failed")
	errStale   = errors.New("reader replaced")
	errDropped = errors.New("buffer dropped")
)

type storeLimits struct {
	chunk, retain, max int
	idle               time.Duration
}

func productionLimits() storeLimits {
	return storeLimits{chunk: chunkBytes, retain: resumeRetainBytes, max: resumeBuffersMaxBytes, idle: resumeIdle}
}

// Store holds one buffered answer per request id.
type Store struct {
	mu     sync.Mutex
	calls  map[string]*call
	pool   *chunkPool
	limits storeLimits
}

func NewStore(limits storeLimits) *Store {
	return &Store{
		calls:  make(map[string]*call),
		pool:   newChunkPool(limits.chunk, limits.max/limits.chunk),
		limits: limits,
	}
}

// reserve claims an id before the upstream call starts; a repeated id is never buffered twice.
func (s *Store) reserve(id string, cancel func()) (*call, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, held := s.calls[id]; held {
		return nil, errHeld
	}
	c := newCall(s, id, cancel)
	s.calls[id] = c
	return c, nil
}

func (s *Store) lookup(id string) *call {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[id]
}

func (s *Store) remove(c *call) {
	s.mu.Lock()
	if s.calls[c.id] == c {
		delete(s.calls, c.id)
	}
	s.mu.Unlock()
}

// evictWritten frees written bytes, never unsent ones: finished calls first, oldest first, then the
// live call holding the most written bytes. It never cancels a call.
func (s *Store) evictWritten() bool {
	s.mu.Lock()
	calls := make([]*call, 0, len(s.calls))
	for _, c := range s.calls {
		calls = append(calls, c)
	}
	s.mu.Unlock()
	type candidate struct {
		c        *call
		finished bool
		at       time.Time
		written  int
	}
	candidates := make([]candidate, 0, len(calls))
	for _, c := range calls {
		finished, at, written := c.evictionView()
		if written > 0 {
			candidates = append(candidates, candidate{c, finished, at, written})
		}
	}
	sort.Slice(candidates, func(i, j int) bool {
		a, b := candidates[i], candidates[j]
		if a.finished != b.finished {
			return a.finished
		}
		if a.finished {
			return a.at.Before(b.at)
		}
		return a.written > b.written
	})
	for _, candidate := range candidates {
		if candidate.c.freeWritten() {
			return true
		}
	}
	return false
}
