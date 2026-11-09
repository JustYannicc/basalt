package main

import (
	"bytes"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestCheckReadsExactInstalledAdmissionWithoutChangingRegistry(t *testing.T) {
	t.Setenv("POOL_APP_SIGNING_KEY", strings.Repeat("6b", 32))
	t.Setenv("POOL_APP_SIGNING_KEY_PREVIOUS", "")
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	previousClock := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousClock; clearPolicyState() })
	keys := signingKeys{current: testSigningKey}
	claims := projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 7,
		ExpiresAt: now.UnixMilli() + 15000, Accounts: []string{"auth-a"}}
	check := func(assertion string) int {
		body, _ := json.Marshal(map[string]string{"assertion": assertion})
		response := httptest.NewRecorder()
		controlHandler().ServeHTTP(response, httptest.NewRequest("POST", "/check", bytes.NewReader(body)))
		return response.Code
	}
	for _, test := range []struct {
		name     string
		snapshot *policySnapshot
		revision int64
		want     int
	}{
		{"clean", testSnapshot(t, now, claims, keys), 7, 200},
		{"missing", nil, 7, 503},
		{"revision", testSnapshot(t, now, claims, keys), 8, 503},
		{"dirty", testSnapshot(t, now, projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 7,
			ExpiresAt: claims.ExpiresAt, Accounts: []string{"auth-a"}, Dirty: true}, keys), 7, 503},
	} {
		t.Run(test.name, func(t *testing.T) {
			registry := &policyRegistry{byPool: map[string]*policySnapshot{}}
			if test.snapshot != nil {
				registry.byPool["pool-a"] = test.snapshot
			}
			activePolicies.Store(registry)
			assertion := testAssertion(t, assertionClaims{Pool: "pool-a", Revision: test.revision, ExpiresAt: now.UnixMilli() + 30000}, testSigningKey)
			if status := check(assertion); status != test.want {
				t.Fatalf("status = %d, want %d", status, test.want)
			}
			if activePolicies.Load() != registry {
				t.Fatal("read-only check replaced the registry")
			}
		})
	}
	if status := check("invalid"); status != 503 {
		t.Fatalf("invalid assertion status = %d", status)
	}
}

func TestCheckRefusesExpiredLocalPolicyWithoutRenewingIt(t *testing.T) {
	t.Setenv("POOL_APP_SIGNING_KEY", strings.Repeat("6b", 32))
	t.Setenv("POOL_APP_SIGNING_KEY_PREVIOUS", "")
	now := time.Now().Truncate(time.Millisecond)
	snapshot := testSnapshot(t, now, projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 1,
		ExpiresAt: now.UnixMilli() + 15000}, signingKeys{current: testSigningKey})
	previousClock := timeNow
	timeNow = func() time.Time { return snapshot.deadline }
	t.Cleanup(func() { timeNow = previousClock; clearPolicyState() })
	registry := &policyRegistry{byPool: map[string]*policySnapshot{"pool-a": snapshot}}
	activePolicies.Store(registry)
	assertion := testAssertion(t, assertionClaims{Pool: "pool-a", Revision: 1, ExpiresAt: snapshot.deadline.UnixMilli() + 30000}, testSigningKey)
	body, _ := json.Marshal(map[string]string{"assertion": assertion})
	response := httptest.NewRecorder()
	controlHandler().ServeHTTP(response, httptest.NewRequest("POST", "/check", bytes.NewReader(body)))
	if response.Code != 503 {
		t.Fatalf("expired check status = %d", response.Code)
	}
	if activePolicies.Load() != registry || !snapshot.deadline.Equal(timeNow()) {
		t.Fatal("check extended expired policy")
	}
}
