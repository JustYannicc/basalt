package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestProjectionFailuresRetainClosedReasonsAndUnchangedAcceptance(t *testing.T) {
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	base := projectionClaims{Pool: "pool", Organization: "organization", Revision: 3, ExpiresAt: now.UnixMilli() + 15000, Accounts: []string{"account"}}
	keys := signingKeys{current: testSigningKey}
	cases := []struct {
		name, reason string
		alter        func(*projectionClaims)
		token        string
		index        *int
		lease        *int64
	}{
		{name: "envelope", reason: "envelope", token: "not-an-envelope"},
		{name: "signature", reason: "signature", token: signEnvelope([]byte(strings.Repeat("q", 32)), projectionPrefix, []byte(`{}`))},
		{name: "json", reason: "json", token: signEnvelope(testSigningKey, projectionPrefix, []byte(`{"private":"never-expose"}`))},
		{name: "identifier", reason: "identifier", alter: func(c *projectionClaims) { c.Pool = " private-identifier " }},
		{name: "organization", reason: "identifier", alter: func(c *projectionClaims) { c.Organization = "" }},
		{name: "revision", reason: "revision", alter: func(c *projectionClaims) { c.Revision = maxSafeInteger + 1 }},
		{name: "expiry", reason: "expiry", alter: func(c *projectionClaims) { c.ExpiresAt = 0 }},
		{name: "account count", reason: "account_count", alter: func(c *projectionClaims) { c.Accounts = make([]string, maxAccountIDs+1) }},
		{name: "account id", reason: "account_id", alter: func(c *projectionClaims) { c.Accounts = []string{"account", " private-id "} }, index: pointer(1)},
		{name: "duplicate", reason: "duplicate_account", alter: func(c *projectionClaims) { c.Accounts = []string{"account", "account"} }, index: pointer(1)},
		{name: "expired", reason: "lease_window", alter: func(c *projectionClaims) { c.ExpiresAt = now.UnixMilli() }, lease: pointer(int64(0))},
		{name: "over upper bound", reason: "lease_window", alter: func(c *projectionClaims) { c.ExpiresAt = now.UnixMilli() + 15001 }, lease: pointer(int64(15001))},
		{name: "old lease bounded", reason: "lease_window", alter: func(c *projectionClaims) { c.ExpiresAt = now.UnixMilli() - 100000 }, lease: pointer(int64(-60000))},
	}
	for _, scenario := range cases {
		t.Run(scenario.name, func(t *testing.T) {
			claims := base
			if scenario.alter != nil {
				scenario.alter(&claims)
			}
			token := scenario.token
			if token == "" {
				token = testProjection(t, claims, testSigningKey)
			}
			snapshot, err := decodeProjection(keys, token, now)
			if snapshot != nil || !errors.Is(err, errInvalidEnvelope) {
				t.Fatalf("want unchanged invalid-envelope refusal, got %v", err)
			}
			expected := map[string]any{"error": "invalid_projection", "reason": scenario.reason}
			if scenario.index != nil {
				expected["accountIndex"] = *scenario.index
			}
			if scenario.lease != nil {
				expected["leaseMs"] = *scenario.lease
			}
			if actual := projectionFailureBody(err); !reflect.DeepEqual(actual, expected) {
				t.Fatalf("diagnostic = %#v, want %#v", actual, expected)
			}
		})
	}
	for _, lease := range []int64{1, 15000} {
		claims := base
		claims.ExpiresAt = now.UnixMilli() + lease
		if _, err := decodeProjection(keys, testProjection(t, claims, testSigningKey), now); err != nil {
			t.Fatalf("valid lease %d refused: %v", lease, err)
		}
	}
}

func pointer[T any](value T) *T { return &value }

func TestInstallHTTPKeepsStatusAndOnlyClosedDiagnosticFields(t *testing.T) {
	clearPolicyState()
	t.Cleanup(clearPolicyState)
	now := time.Date(2026, 11, 9, 10, 0, 0, 0, time.UTC)
	previousNow := timeNow
	timeNow = func() time.Time { return now }
	t.Cleanup(func() { timeNow = previousNow })
	t.Setenv("POOL_APP_SIGNING_KEY", strings.Repeat("6b", 32))
	t.Setenv("POOL_APP_SIGNING_KEY_PREVIOUS", "")
	claims := projectionClaims{Pool: "pool", Organization: "organization", Revision: 3, ExpiresAt: now.UnixMilli() + 15000, Accounts: []string{"account"}}
	call := func(body string) (int, map[string]any) {
		response := httptest.NewRecorder()
		controlHandler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/install", strings.NewReader(body)))
		var value map[string]any
		if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		return response.Code, value
	}
	for _, scenario := range []struct{ body, reason string }{
		{`{"private":"never-expose"}`, "json"},
		{`{"projection":""}`, "envelope"},
		{`{"projection":"sbm-policy1.e30.bad"}`, "signature"},
	} {
		status, value := call(scenario.body)
		if status != 400 || !reflect.DeepEqual(value, map[string]any{"error": "invalid_projection", "reason": scenario.reason}) {
			t.Fatalf("status/body = %d %#v", status, value)
		}
	}
	body, _ := json.Marshal(installRequest{Projection: testProjection(t, claims, testSigningKey)})
	status, value := call(string(body))
	if status != 200 || !reflect.DeepEqual(value, map[string]any{"installed": true, "revision": float64(3)}) {
		t.Fatalf("valid install = %d %#v", status, value)
	}
	claims.Revision = 2
	body, _ = json.Marshal(installRequest{Projection: testProjection(t, claims, testSigningKey)})
	status, value = call(string(body))
	if status != 409 || !reflect.DeepEqual(value, map[string]any{"error": "invalid_projection", "reason": "revision"}) {
		t.Fatalf("stale install = %d %#v", status, value)
	}
}

func TestProjectionDiagnosticRefusesUnexpectedReasonAndNumericContext(t *testing.T) {
	for _, failure := range []*projectionFailure{
		{reason: "private-value", accountIndex: pointer(0), leaseMs: pointer(int64(12))},
		{reason: "envelope", accountIndex: pointer(0), leaseMs: pointer(int64(12))},
		{reason: "account_id", accountIndex: pointer(4096)},
	} {
		expectedReason := failure.reason
		if expectedReason == "private-value" {
			expectedReason = "envelope"
		}
		if actual := projectionFailureBody(failure); !reflect.DeepEqual(actual, map[string]any{"error": "invalid_projection", "reason": expectedReason}) {
			t.Fatalf("unexpected diagnostic: %#v", actual)
		}
	}
}
