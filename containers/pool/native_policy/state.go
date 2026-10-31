package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

var (
	activePolicies atomic.Pointer[policyRegistry]
	installMu      sync.Mutex
	latestRevision = map[string]int64{}
)

var errStaleProjection = errors.New("stale or conflicting projection")

func installPolicyEnvelope(token string, keys signingKeys, now time.Time) (int64, error) {
	candidate, errDecode := decodeProjection(keys, token, now)
	if errDecode != nil {
		return 0, errDecode
	}

	installMu.Lock()
	defer installMu.Unlock()
	currentRegistry := activePolicies.Load()
	if currentRegistry == nil {
		currentRegistry = &policyRegistry{byPool: map[string]*policySnapshot{}}
	}
	current := currentRegistry.byPool[candidate.claims.Pool]
	if candidate.claims.Revision < latestRevision[candidate.claims.Pool] {
		return 0, errStaleProjection
	}
	if current != nil && candidate.claims.Revision == current.claims.Revision {
		if !samePolicy(current.claims, candidate.claims) ||
			candidate.claims.ExpiresAt < current.claims.ExpiresAt {
			return 0, errStaleProjection
		}
	}
	if candidate.claims.Revision > latestRevision[candidate.claims.Pool] {
		latestRevision[candidate.claims.Pool] = candidate.claims.Revision
	}
	next := make(map[string]*policySnapshot, len(currentRegistry.byPool)+1)
	for pool, snapshot := range currentRegistry.byPool {
		next[pool] = snapshot
	}
	next[candidate.claims.Pool] = candidate
	activePolicies.Store(&policyRegistry{byPool: next})
	return candidate.claims.Revision, nil
}

func clearPolicyState() {
	installMu.Lock()
	activePolicies.Store(&policyRegistry{byPool: map[string]*policySnapshot{}})
	latestRevision = map[string]int64{}
	installMu.Unlock()
}
