"""Home stops without losing a rotated token, and a rejected refresh is visible."""

from __future__ import annotations

import pathlib
import re
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from . import pool_contract, supervisor
from .child_signals import safe_child_output_line
from .readiness import Readiness
from .service_health import ServiceHealth

ROOT = pathlib.Path(__file__).resolve().parent
REF = "sha256:" + "a" * 64
UUID = "11111111-2222-4333-8444-555555555555"


def home_answers(payload: dict, status: int = 200):
    responses = {
        f"{pool_contract.NODE_URL}/healthz": (200, {"status": "ok"}),
        f"{pool_contract.HOME_URL}/healthz": (status, payload),
    }
    return patch.object(pool_contract, "request_json", side_effect=lambda url, *_a, **_k: responses[url])


class RefreshInFlightTests(unittest.TestCase):
    def test_ready_carries_homes_refresh_count_only_while_it_is_fresh(self) -> None:
        now = [10_000_000_000]
        ready = Readiness("fixture", monotonic_ns=lambda: now[0])
        self.assertNotIn("refresh_in_flight", ready.snapshot()[1])
        ready.note_refresh_in_flight(2)
        self.assertEqual(ready.snapshot()[1]["refresh_in_flight"], 2)
        ready.set_ready(True)
        ready.refresh_policy_lease("b" * 32)
        serving, body = ready.snapshot()
        self.assertTrue(serving)
        self.assertEqual(body["refresh_in_flight"], 2)
        now[0] += 3_100_000_000
        self.assertNotIn("refresh_in_flight", ready.snapshot()[1])
        ready.note_refresh_in_flight(0)
        self.assertEqual(ready.snapshot()[1]["refresh_in_flight"], 0)
        ready.note_refresh_in_flight(None)
        self.assertNotIn("refresh_in_flight", ready.snapshot()[1])

    def test_the_liveness_check_hands_homes_count_to_readiness(self) -> None:
        seen: list[int | None] = []
        with home_answers({"status": "ok", "refresh_in_flight": 1}):
            ServiceHealth("key", "node", observe=seen.append).check()
        self.assertEqual(seen, [1])
        for unusable in (True, -1, "1", 1.5, None, 1 << 63):
            with home_answers({"status": "ok", "refresh_in_flight": unusable}):
                self.assertTrue(pool_contract.check_liveness("key", observe=seen.append))
            self.assertIsNone(seen[-1], unusable)
        with home_answers({"status": "ok"}):
            pool_contract.check_liveness("key", observe=seen.append)
        self.assertIsNone(seen[-1])
        seen.append(3)
        with home_answers({}, status=503):
            self.assertFalse(pool_contract.check_liveness("key", observe=seen.append))
        self.assertIsNone(seen[-1], "a Home that does not answer has no known count")


class StopGraceTests(unittest.TestCase):
    def test_home_gets_longer_than_its_refresh_drain_to_stop(self) -> None:
        carry = (ROOT / "patches" / "0695-home-safe-stop.patch").read_text(encoding="utf-8")
        drain = re.search(r"\+const refreshDrainTimeout = ([0-9]+) \* time\.Second", carry)
        self.assertIsNotNone(drain, "the carry's drain bound moved")
        # Home shuts its HTTP server (up to 5 s) before it drains, then retires its node row.
        self.assertGreaterEqual(supervisor.CHILD_STOP_GRACE_SECONDS, int(drain.group(1)) + 10)

    def test_a_stop_waits_the_full_grace_before_killing_home(self) -> None:
        waits: list[float] = []
        process = SimpleNamespace(
            poll=lambda: None, terminate=Mock(), kill=Mock(), wait=lambda timeout=None: waits.append(timeout)
        )
        with patch.object(supervisor, "current_deadline", return_value=None):
            supervisor.terminate_children([SimpleNamespace(process=process)])
        self.assertGreaterEqual(waits[0], supervisor.CHILD_STOP_GRACE_SECONDS - 1)
        self.assertGreaterEqual(waits[0], 59)


class RejectedRefreshSignalTests(unittest.TestCase):
    def line(self, message: str) -> str:
        return f"[CLIProxyAPIHome] [2026-11-19 00:00:00] [--------] [warn ] {message}"

    def test_a_rejected_refresh_is_forwarded_with_its_reference_and_closed_reason(self) -> None:
        self.assertEqual(
            safe_child_output_line("home", self.line(f"credential refresh rejected credential={REF} reason=refresh_token_reused")),
            'POOL_CREDENTIAL_REFRESH_REJECTED {"account_ref":"' + REF + '","reason":"refresh_token_reused"}',
        )
        self.assertEqual(
            safe_child_output_line(
                "home", f'time="2026-11-19T00:00:00Z" level=warning msg="credential refresh rejected credential={UUID} reason=invalid_grant"'
            ),
            'POOL_CREDENTIAL_REFRESH_REJECTED {"account_ref":"' + UUID + '","reason":"invalid_grant"}',
        )

    def test_a_rejection_line_with_anything_open_is_dropped(self) -> None:
        for message in (
            "credential refresh rejected credential=person@example.com reason=invalid_grant",
            f"credential refresh rejected credential={REF} reason=provider_said_something",
            f"credential refresh rejected credential={REF} reason=invalid_grant body=private",
            f"credential refresh rejected credential={REF}x reason=invalid_grant",
        ):
            self.assertIsNone(safe_child_output_line("home", self.line(message)), message)
        self.assertIsNone(
            safe_child_output_line("node", f"credential refresh rejected credential={REF} reason=invalid_grant")
        )


if __name__ == "__main__":
    unittest.main()
