package main

import "errors"

type projectionFailure struct {
	reason       string
	accountIndex *int
	leaseMs      *int64
}

func (failure *projectionFailure) Error() string { return errInvalidEnvelope.Error() }
func (failure *projectionFailure) Unwrap() error { return errInvalidEnvelope }

// Only fixed classes and bounded numeric context cross the private control socket.
func projectionFailureBody(err error) map[string]any {
	body := map[string]any{"error": "invalid_projection"}
	if errors.Is(err, errStaleProjection) {
		body["reason"] = "revision"
		return body
	}
	var failure *projectionFailure
	if !errors.As(err, &failure) {
		body["reason"] = "envelope"
		return body
	}
	switch failure.reason {
	case "envelope", "signature", "json", "identifier", "revision", "expiry", "account_count", "account_id", "duplicate_account", "lease_window":
		body["reason"] = failure.reason
	default:
		body["reason"] = "envelope"
		return body
	}
	if (failure.reason == "account_id" || failure.reason == "duplicate_account") && failure.accountIndex != nil && *failure.accountIndex >= 0 && *failure.accountIndex < maxAccountIDs {
		body["accountIndex"] = *failure.accountIndex
	}
	if failure.reason == "lease_window" && failure.leaseMs != nil {
		body["leaseMs"] = max(int64(-60_000), min(int64(60_000), *failure.leaseMs))
	}
	return body
}
