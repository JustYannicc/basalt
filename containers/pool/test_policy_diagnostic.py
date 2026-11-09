"""Native policy diagnostics preserve closed reasons and HTTP refusal boundaries."""

import http.client
import http.server
import json
import threading
import unittest
from unittest.mock import patch

from . import readiness
from .policy_diagnostic import POLICY_REASONS, policy_failure


class PolicyDiagnosticTests(unittest.TestCase):
    def setUp(self):
        ready = readiness.Readiness("fixture-management")
        handler = type("PolicyReadyHandler", (readiness.ReadyHandler,), {"readiness": ready})
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(self.server.shutdown)

    def request(self, body, headers=None):
        connection = http.client.HTTPConnection(*self.server.server_address, timeout=1)
        self.addCleanup(connection.close)
        connection.request("POST", "/native-policy", body=body, headers={
            "Authorization": "Bearer fixture-management", **(headers or {}),
        })
        response = connection.getresponse()
        return response.status, json.loads(response.read())

    def test_closed_reason_and_only_matching_bounded_numbers_cross_the_adapter(self):
        for reason in POLICY_REASONS:
            with self.subTest(reason=reason):
                expected = {"error": "invalid_projection", "reason": reason}
                if reason in ("account_id", "duplicate_account"):
                    expected["accountIndex"] = 4
                if reason == "lease_window":
                    expected["leaseMs"] = 15001
                with patch.object(readiness, "native_policy_request", return_value=(400, {
                    "error": "private-error", "reason": reason,
                    "accountIndex": 4, "leaseMs": 15001, "private": "never-forward",
                })):
                    self.assertEqual(self.request(json.dumps({"projection": "synthetic"})), (400, expected))

    def test_unknown_reasons_and_unsafe_numeric_context_are_dropped(self):
        for result in (
            {"reason": "private-value"},
            {"reason": ["json"]},
            {"reason": "account_id", "accountIndex": True},
            {"reason": "account_id", "accountIndex": -1},
            {"reason": "account_id", "accountIndex": 4096},
            {"reason": "lease_window", "leaseMs": True},
            {"reason": "lease_window", "leaseMs": 60001},
            {"reason": "lease_window", "leaseMs": -60001},
            {"reason": "signature", "accountIndex": 2, "leaseMs": 10},
        ):
            expected = {"error": "invalid_projection"}
            if isinstance(result["reason"], str) and result["reason"] in POLICY_REASONS:
                expected["reason"] = result["reason"]
            self.assertEqual(policy_failure(result), expected)

    def test_framing_failures_are_distinct_and_never_reach_the_native_plugin(self):
        for body, reason, headers in (
            ("x", "envelope", {}),
            ("{{", "json", {}),
            ("{}", "envelope", {}),
            ('{"projection":"a","projection":"b"}', "json", {}),
            ("{}", "envelope", {"Content-Length": "nonsense"}),
        ):
            with self.subTest(reason=reason), patch.object(readiness, "native_policy_request") as install:
                self.assertEqual(self.request(body, headers), (400, {"error": "invalid_projection_framing", "reason": reason}))
                install.assert_not_called()

    def test_stale_revision_and_legacy_refusals_keep_their_status(self):
        for status, result, expected in (
            (409, {"reason": "revision"}, {"error": "invalid_projection", "reason": "revision"}),
            (400, {}, {"error": "invalid_projection"}),
            (503, {"reason": "json"}, {"error": "policy_unavailable"}),
        ):
            with patch.object(readiness, "native_policy_request", return_value=(status, result)):
                self.assertEqual(self.request(json.dumps({"projection": "synthetic"})), (status, expected))
