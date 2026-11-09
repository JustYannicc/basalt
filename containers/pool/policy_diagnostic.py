"""Closed diagnostics from the native policy socket; never forward backend data."""

from typing import Any

POLICY_REASONS = frozenset({
    "envelope", "signature", "json", "identifier", "revision", "expiry",
    "account_count", "account_id", "duplicate_account", "lease_window",
})


def policy_failure(result: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = {"error": "invalid_projection"}
    reason = result.get("reason")
    if not isinstance(reason, str) or reason not in POLICY_REASONS:
        return body
    body["reason"] = reason
    index = result.get("accountIndex")
    if reason in ("account_id", "duplicate_account") and type(index) is int and 0 <= index < 4096:
        body["accountIndex"] = index
    lease_ms = result.get("leaseMs")
    if reason == "lease_window" and type(lease_ms) is int and -60_000 <= lease_ms <= 60_000:
        body["leaseMs"] = lease_ms
    return body
