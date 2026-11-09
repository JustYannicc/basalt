package main

import (
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestInstall400RetainsLastCleanPolicyThroughTwoHourOutageAndStopsAt24HourGrace(t *testing.T) {
	clearPolicyState()
	t.Cleanup(clearPolicyState)
	t.Setenv("POOL_APP_SIGNING_KEY", hex.EncodeToString(testSigningKey))
	t.Setenv("POOL_APP_SIGNING_KEY_PREVIOUS", "")
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	clock := now
	originalClock := timeNow
	timeNow = func() time.Time { return clock }
	t.Cleanup(func() { timeNow = originalClock })
	base := projectionClaims{Pool: "pool", Organization: "org", Revision: 8,
		ExpiresAt: now.Add(15 * time.Second).UnixMilli(), Accounts: []string{"account"}}
	install := func(token string) int {
		request := httptest.NewRequest(http.MethodPost, "/install", strings.NewReader(fmt.Sprintf(`{"projection":%q}`, token)))
		reply := httptest.NewRecorder()
		controlHandler().ServeHTTP(reply, request)
		return reply.Code
	}
	if status := install(testProjection(t, base, testSigningKey)); status != http.StatusOK {
		t.Fatalf("first policy install status = %d", status)
	}
	check := func(want string) {
		t.Helper()
		assertion := testAssertion(t, assertionClaims{Pool: "pool", Revision: 8, ExpiresAt: clock.Add(time.Minute).UnixMilli()}, testSigningKey)
		got := evaluatePick(policyRequest(assertion, "account"), activePolicies.Load(), signingKeys{current: testSigningKey}, clock)
		if got.code != want || got.handled != (want != "") {
			t.Fatalf("pick after %s = %#v, want %q", clock.Sub(now), got, want)
		}
	}
	clock = now.Add(2 * time.Hour)
	if status := install("sbm-policy1.invalid.invalid"); status != http.StatusBadRequest {
		t.Fatalf("rejected renewal status = %d, want 400", status)
	}
	check("")
	clock = now.Add(15*time.Second + 24*time.Hour - time.Millisecond)
	if status := install("sbm-policy1.invalid.invalid"); status != http.StatusBadRequest {
		t.Fatalf("later rejected renewal status = %d, want 400", status)
	}
	check("")
	clock = clock.Add(time.Millisecond)
	check("native_policy_unavailable")
	// An old signed envelope cannot re-install itself to restart the grace window.
	if status := install(testProjection(t, base, testSigningKey)); status != http.StatusBadRequest {
		t.Fatalf("expired envelope replay status = %d, want 400", status)
	}
	check("native_policy_unavailable")
}

func TestGraceNeverExtendsSignedInstallAcceptanceOrRequestAssertions(t *testing.T) {
	now := time.Now().Truncate(time.Millisecond)
	keys := signingKeys{current: testSigningKey}
	for _, remaining := range []time.Duration{-time.Millisecond, 0, 15*time.Second + time.Millisecond, 24 * time.Hour} {
		claims := projectionClaims{Pool: "pool", Organization: "org", Revision: 1,
			ExpiresAt: now.Add(remaining).UnixMilli(), Accounts: []string{"account"}}
		if _, err := decodeProjection(keys, testProjection(t, claims, testSigningKey), now); err == nil {
			t.Fatalf("invalid signed install lifetime %s accepted", remaining)
		}
	}
}

func TestHigherRevisionDirtyPolicyImmediatelyVetoesAnInstalledGracePolicy(t *testing.T) {
	clearPolicyState()
	t.Cleanup(clearPolicyState)
	now := time.Now().Truncate(time.Millisecond)
	keys := signingKeys{current: testSigningKey}
	base := projectionClaims{Pool: "pool", Organization: "org", Revision: 1,
		ExpiresAt: now.Add(15 * time.Second).UnixMilli(), Accounts: []string{"account"}}
	if _, err := installPolicyEnvelope(testProjection(t, base, testSigningKey), keys, now); err != nil {
		t.Fatal(err)
	}
	clock := now.Add(2 * time.Hour)
	dirty := base
	dirty.Revision++
	dirty.Dirty = true
	dirty.ExpiresAt = clock.Add(15 * time.Second).UnixMilli()
	if _, err := installPolicyEnvelope(testProjection(t, dirty, testSigningKey), keys, clock); err != nil {
		t.Fatal(err)
	}
	for _, revision := range []int64{base.Revision, dirty.Revision} {
		assertion := testAssertion(t, assertionClaims{Pool: "pool", Revision: revision, ExpiresAt: clock.Add(time.Minute).UnixMilli()}, testSigningKey)
		if got := evaluatePick(policyRequest(assertion, "account"), activePolicies.Load(), keys, clock); got.code != "native_policy_unavailable" {
			t.Fatalf("revoked pick = %#v", got)
		}
	}
	if !activePolicies.Load().byPool["pool"].deadline.Equal(clock.Add(15 * time.Second)) {
		t.Fatal("dirty policy inherited grace")
	}
}
