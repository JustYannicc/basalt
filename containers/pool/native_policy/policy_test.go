package main

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

var testSigningKey = []byte(strings.Repeat("k", 32))

func TestPolicyPickVetoesWholeCandidateSetAndLeavesAllowedSetToHome(t *testing.T) {
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)
	claims := projectionClaims{
		Pool: "pool-a", Organization: "org-a", Revision: 7,
		ExpiresAt: now.UnixMilli() + int64(maxProjectionTTL/time.Millisecond),
		Accounts:  []string{"home-auth-a", "home-auth-b"},
	}
	snapshot := testSnapshot(t, now, claims, signingKeys{current: testSigningKey})
	registry := &policyRegistry{byPool: map[string]*policySnapshot{"pool-a": snapshot}}
	keys := signingKeys{current: testSigningKey}

	assertion := testAssertion(t, assertionClaims{
		Pool: "pool-a", Revision: 7,
		ExpiresAt: now.UnixMilli() + int64(maxAssertionTTL/time.Millisecond),
	}, testSigningKey)
	allowed := policyRequest(assertion, "home-auth-a", "home-auth-b")
	if got := evaluatePick(allowed, registry, keys, now); got.handled || got.code != "" {
		t.Fatalf("all-permitted pick = %#v, want Home to keep selecting", got)
	}
	unauthorized := policyRequest(assertion, "home-auth-a", "other-pool-auth")
	if got := evaluatePick(unauthorized, registry, keys, now); !got.handled || got.code != "native_policy_denied" {
		t.Fatalf("mixed-permission pick = %#v, want whole-pick veto", got)
	}
}

func TestPolicyPickTreatsMissingAssertionAsLegacyAndRejectsMalformedAssertion(t *testing.T) {
	now := time.Now().Truncate(time.Millisecond)
	legacy := pluginapi.SchedulerPickRequest{Candidates: []pluginapi.SchedulerAuthCandidate{{ID: "auth"}}}
	if got := evaluatePick(legacy, nil, signingKeys{}, now); got.handled || got.code != "" {
		t.Fatalf("legacy pick = %#v, want unhandled", got)
	}
	for name, values := range map[string][]string{
		"empty":     {""},
		"duplicate": {"sbm-use1.a.b", "sbm-use1.a.b"},
	} {
		t.Run(name, func(t *testing.T) {
			req := legacy
			req.Options.Headers = map[string][]string{"X-Signalbox-Native-Policy": values}
			if got := evaluatePick(req, nil, signingKeys{}, now); !got.handled || got.code != "native_policy_invalid" {
				t.Fatalf("invalid assertion pick = %#v, want hard veto", got)
			}
		})
	}
}

func TestPolicyPickChecksPoolRevisionExpiryAndDirtyState(t *testing.T) {
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)
	claims := projectionClaims{
		Pool: "pool-a", Organization: "org-a", Revision: 11,
		ExpiresAt: now.UnixMilli() + int64(maxProjectionTTL/time.Millisecond),
		Accounts:  []string{"home-auth"},
	}
	snapshot := testSnapshot(t, now, claims, signingKeys{current: testSigningKey})
	registry := &policyRegistry{byPool: map[string]*policySnapshot{"pool-a": snapshot}}
	keys := signingKeys{current: testSigningKey}
	tests := []struct {
		name      string
		assertion assertionClaims
		now       time.Time
		snapshot  *policySnapshot
		want      string
	}{
		{name: "wrong pool", assertion: assertionClaims{Pool: "pool-b", Revision: 11, ExpiresAt: now.UnixMilli() + 1000}, snapshot: snapshot, want: "native_policy_unavailable"},
		{name: "stale revision", assertion: assertionClaims{Pool: "pool-a", Revision: 10, ExpiresAt: now.UnixMilli() + 1000}, snapshot: snapshot, want: "native_policy_unavailable"},
		{name: "expired request assertion", assertion: assertionClaims{Pool: "pool-a", Revision: 11, ExpiresAt: now.UnixMilli() - 1}, snapshot: snapshot, want: "native_policy_invalid"},
		{name: "assertion over two hours", assertion: assertionClaims{Pool: "pool-a", Revision: 11, ExpiresAt: now.UnixMilli() + int64(maxAssertionTTL/time.Millisecond) + 1}, snapshot: snapshot, want: "native_policy_invalid"},
		{name: "expired local projection", assertion: assertionClaims{Pool: "pool-a", Revision: 11, ExpiresAt: now.UnixMilli() + int64(maxAssertionTTL/time.Millisecond)}, now: now.Add(maxProjectionTTL), snapshot: snapshot, want: "native_policy_unavailable"},
		{name: "dirty local projection", assertion: assertionClaims{Pool: "pool-a", Revision: 11, ExpiresAt: now.UnixMilli() + int64(maxAssertionTTL/time.Millisecond)}, snapshot: testSnapshot(t, now, projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 11, ExpiresAt: claims.ExpiresAt, Accounts: []string{"home-auth"}, Dirty: true}, keys), want: "native_policy_unavailable"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clock := test.now
			if clock.IsZero() {
				clock = now
			}
			assertion := testAssertion(t, test.assertion, testSigningKey)
			req := policyRequest(assertion, "home-auth")
			target := test.snapshot
			if target == nil {
				target = registry.byPool["pool-a"]
			}
			got := evaluatePick(req, &policyRegistry{byPool: map[string]*policySnapshot{"pool-a": target}}, keys, clock)
			if !got.handled || got.code != test.want {
				t.Fatalf("pick = %#v, want veto %s", got, test.want)
			}
		})
	}
}

func TestProjectionInstallationIsMonotonicPerPool(t *testing.T) {
	clearPolicyState()
	t.Cleanup(clearPolicyState)
	now := time.Date(2026, 10, 31, 10, 0, 0, 0, time.UTC)
	keys := signingKeys{current: testSigningKey}
	install := func(claims projectionClaims) error {
		token := testProjection(t, claims, testSigningKey)
		_, errInstall := installPolicyEnvelope(token, keys, now)
		return errInstall
	}
	base := projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 8, ExpiresAt: now.UnixMilli() + 10_000, Accounts: []string{"a", "b"}}
	if errInstall := install(base); errInstall != nil {
		t.Fatalf("first projection install: %v", errInstall)
	}
	if errInstall := install(projectionClaims{Pool: "pool-b", Organization: "org-b", Revision: 1, ExpiresAt: now.UnixMilli() + 10_000, Accounts: []string{"other"}}); errInstall != nil {
		t.Fatalf("independent pool install: %v", errInstall)
	}
	if errInstall := install(projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 7, ExpiresAt: now.UnixMilli() + 10_000, Accounts: []string{"old"}}); !errors.Is(errInstall, errStaleProjection) {
		t.Fatalf("stale revision install error = %v, want stale rejection", errInstall)
	}
	shrunk := base
	shrunk.ExpiresAt -= 1
	if errInstall := install(shrunk); !errors.Is(errInstall, errStaleProjection) {
		t.Fatalf("same-revision shorter lease error = %v, want stale rejection", errInstall)
	}
	changed := base
	changed.Accounts = []string{"a", "new"}
	if errInstall := install(changed); !errors.Is(errInstall, errStaleProjection) {
		t.Fatalf("same-revision changed membership error = %v, want conflict", errInstall)
	}
	if errInstall := install(base); errInstall != nil {
		t.Fatalf("idempotent same-revision refresh: %v", errInstall)
	}
	registry := activePolicies.Load()
	if len(registry.byPool) != 2 || registry.byPool["pool-a"].claims.Revision != 8 || registry.byPool["pool-b"].claims.Revision != 1 {
		t.Fatalf("installed policy registry = %#v, want per-pool revisions", registry)
	}
}

func TestProjectionRejectsMalformedClaimsAndKeyRotationAcceptsPreviousKey(t *testing.T) {
	now := time.Now().Truncate(time.Millisecond)
	claims := projectionClaims{Pool: "pool-a", Organization: "org-a", Revision: 1, ExpiresAt: now.UnixMilli() + 10_000, Accounts: []string{"home-auth"}}
	previous := []byte(strings.Repeat("p", 32))
	previousToken := testProjection(t, claims, previous)
	if _, errDecode := decodeProjection(signingKeys{current: testSigningKey, previous: previous}, previousToken, now); errDecode != nil {
		t.Fatalf("previous-key projection: %v", errDecode)
	}
	if _, errDecode := decodeProjection(signingKeys{current: testSigningKey}, previousToken, now); errDecode == nil {
		t.Fatal("projection signed by unconfigured key was accepted")
	}
	for name, invalid := range map[string]projectionClaims{
		"empty pool":      {Organization: "org", Revision: 1, ExpiresAt: now.UnixMilli() + 1},
		"unsafe revision": {Pool: "pool", Organization: "org", Revision: maxSafeInteger + 1, ExpiresAt: now.UnixMilli() + 1},
		"duplicate IDs":   {Pool: "pool", Organization: "org", Revision: 1, ExpiresAt: now.UnixMilli() + 1, Accounts: []string{"a", "a"}},
		"oversized list":  {Pool: "pool", Organization: "org", Revision: 1, ExpiresAt: now.UnixMilli() + 1, Accounts: make([]string, maxAccountIDs+1)},
	} {
		t.Run(name, func(t *testing.T) {
			if _, errDecode := decodeProjection(signingKeys{current: testSigningKey}, testProjection(t, invalid, testSigningKey), now); errDecode == nil {
				t.Fatal("invalid projection was accepted")
			}
		})
	}
}

func TestSamePolicyIgnoresAccountOrdering(t *testing.T) {
	left := projectionClaims{Pool: "pool", Organization: "org", Revision: 1, Accounts: []string{"a", "b"}}
	right := left
	right.Accounts = []string{"b", "a"}
	if !samePolicy(left, right) {
		t.Fatal("same membership in a different order was treated as changed")
	}
}

func BenchmarkEvaluatePick(b *testing.B) {
	now := time.Now().Truncate(time.Millisecond)
	claims := projectionClaims{
		Pool: "pool-bench", Organization: "org-bench", Revision: 1,
		ExpiresAt: now.UnixMilli() + int64(maxProjectionTTL/time.Millisecond),
		Accounts:  []string{"home-auth"},
	}
	snapshot, errSnapshot := decodeProjection(signingKeys{current: testSigningKey}, testProjection(b, claims, testSigningKey), now)
	if errSnapshot != nil {
		b.Fatal(errSnapshot)
	}
	assertion := testAssertion(b, assertionClaims{Pool: claims.Pool, Revision: 1, ExpiresAt: now.UnixMilli() + 3_600_000}, testSigningKey)
	registry := &policyRegistry{byPool: map[string]*policySnapshot{claims.Pool: snapshot}}
	request := policyRequest(assertion, "home-auth")
	keys := signingKeys{current: testSigningKey}
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		decision := evaluatePick(request, registry, keys, now)
		if decision.handled {
			b.Fatal(decision.code)
		}
	}
}

func testProjection(t testing.TB, claims projectionClaims, key []byte) string {
	t.Helper()
	data, errMarshal := json.Marshal(claims)
	if errMarshal != nil {
		t.Fatalf("encode projection: %v", errMarshal)
	}
	return signEnvelope(key, projectionPrefix, data)
}

func testAssertion(t testing.TB, claims assertionClaims, key []byte) string {
	t.Helper()
	data, errMarshal := json.Marshal(claims)
	if errMarshal != nil {
		t.Fatalf("encode assertion: %v", errMarshal)
	}
	return signEnvelope(key, assertionPrefix, data)
}

func testSnapshot(t testing.TB, now time.Time, claims projectionClaims, keys signingKeys) *policySnapshot {
	t.Helper()
	snapshot, errDecode := decodeProjection(keys, testProjection(t, claims, keys.current), now)
	if errDecode != nil {
		t.Fatalf("decode projection: %v", errDecode)
	}
	return snapshot
}

func policyRequest(assertion string, authIDs ...string) pluginapi.SchedulerPickRequest {
	candidates := make([]pluginapi.SchedulerAuthCandidate, 0, len(authIDs))
	for _, id := range authIDs {
		candidates = append(candidates, pluginapi.SchedulerAuthCandidate{ID: id})
	}
	return pluginapi.SchedulerPickRequest{
		Options: pluginapi.SchedulerOptions{Headers: map[string][]string{
			"X-Signalbox-Native-Policy": {assertion},
		}},
		Candidates: candidates,
	}
}
