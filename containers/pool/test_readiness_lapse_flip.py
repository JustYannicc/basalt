"""The /ready lapse and flip records: one per transition, only the last kept, closed fields."""

from __future__ import annotations

import json
import threading
import unittest
from unittest.mock import patch

from . import policy_monitor
from . import readiness as readiness_module
from .readiness import (
    FLIP_LINE,
    LAPSE_LINE,
    LAPSE_STEPS,
    POLICY_HEALTH_LEASE_NS,
    POLICY_PLUGIN_ID,
    Readiness,
)

INSTANCE = "a" * 32
TOKEN_SENTINEL = "private-token-sentinel"
MS = 1_000_000


class Clock:
    def __init__(self) -> None:
        self.now = 10_000 * MS

    def __call__(self) -> int:
        return self.now

    def advance(self, ms: int) -> None:
        self.now += ms * MS


class LapseFlipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.lines: list[str] = []
        patcher = patch.object(readiness_module, "emit", lambda line, err=False: self.lines.append(line))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.readiness = Readiness("key", self.clock)

    def serve(self) -> None:
        """A healthy probe and a passing service audit: the runtime is ready."""
        self.readiness.note_probe_step("home_plugins")
        self.readiness.note_probe_step(None)
        self.assertTrue(self.readiness.refresh_policy_lease(INSTANCE))
        self.readiness.set_ready(True, audit_revision=self.readiness.service_audit_revision())

    def payload(self) -> dict[str, object]:
        return self.readiness.readiness_response()[1]

    def test_a_quiet_runtime_answers_as_older_images_do(self) -> None:
        self.assertEqual(set(self.payload()), {"boot_id", "started_at", "db_rtt_state", "refusal"})

    def test_ready_and_lapse_flip_with_the_prior_state_duration(self) -> None:
        self.clock.advance(4_000)
        self.serve()
        flip = self.payload()["last_flip"]
        self.assertEqual({k: flip[k] for k in ("to", "reason", "prior_ms")}, {"to": "ready", "reason": "restored", "prior_ms": 4_000})
        self.clock.advance(1_500)
        payload = self.payload()
        self.assertEqual(payload["refusal"], "policy_unproven")
        self.assertEqual(payload["flips"], 2)
        self.assertEqual(payload["last_flip"]["to"], "refusing")
        self.assertEqual(payload["last_flip"]["reason"], "policy_unproven")
        # The state lasted until the lease's own deadline, not until someone asked.
        self.assertEqual(payload["last_flip"]["prior_ms"], 1_500)
        self.assertEqual(payload["lapses"], 1)
        self.assertEqual(payload["last_lapse"]["step"], "no_probe")
        self.assertEqual(
            self.lines,
            [
                FLIP_LINE + '{"to":"ready","reason":"restored","prior_ms":4000}',
                LAPSE_LINE + '{"step":"no_probe","ms":1500}',
                FLIP_LINE + '{"to":"refusing","reason":"policy_unproven","prior_ms":1500}',
            ],
        )

    def test_a_lapse_names_the_slowest_step_of_the_probe_in_flight(self) -> None:
        self.serve()
        self.clock.advance(250)
        self.readiness.note_probe_step("home_plugins")
        self.clock.advance(40)
        self.readiness.note_probe_step("plugin_probe")
        self.clock.advance(1_300)
        lapse = self.payload()["last_lapse"]
        # Measured to the lease's deadline, not to the moment someone asked.
        self.assertEqual((lapse["step"], lapse["ms"]), ("plugin_probe", 1_210))

    def probe(self, *steps: tuple[str, int], missed: bool) -> None:
        for step, ms in steps:
            self.readiness.note_probe_step(step)
            self.clock.advance(ms)
        self.readiness.note_probe_step(None, missed=missed)

    def test_a_lapse_noticed_by_the_next_renewal_names_where_the_misses_stopped(self) -> None:
        self.serve()
        for _ in range(2):
            self.clock.advance(255)
            self.probe(("home_plugins", 3), ("plugin_probe", 2), ("probe_log", 245), missed=True)
        self.clock.advance(1_000)
        self.probe(("home_plugins", 2), ("plugin_probe", 1), ("probe_log", 2), missed=False)
        # The healthy probe's renewal is what notices the lease ran out.
        self.assertTrue(self.readiness.refresh_policy_lease(INSTANCE))
        lapse = self.payload()["last_lapse"]
        self.assertEqual((lapse["step"], lapse["ms"]), ("probe_log", 245))

    def test_a_fast_failure_is_named_over_a_slower_step_before_it(self) -> None:
        self.serve()
        self.clock.advance(250)
        self.probe(("home_plugins", 200), ("plugin_probe", 3), missed=True)
        self.clock.advance(1_200)
        lapse = self.payload()["last_lapse"]
        self.assertEqual((lapse["step"], lapse["ms"]), ("plugin_probe", 3))

    def test_a_lapse_noticed_late_keeps_its_order_and_deadline(self) -> None:
        self.serve()
        revision = self.readiness.service_audit_revision()
        self.clock.advance(3_300)
        # A health check that blocked past the deadline reports back before anyone asked /ready.
        self.readiness.set_ready(True, audit_revision=revision)
        flips = [line for line in self.lines if line.startswith((LAPSE_LINE, FLIP_LINE))]
        self.assertEqual(flips[-2:], [
            LAPSE_LINE + '{"step":"no_probe","ms":1500}',
            FLIP_LINE + '{"to":"refusing","reason":"policy_unproven","prior_ms":1500}',
        ])

    def test_an_unnoticed_lapse_is_not_lost_to_an_invalidation(self) -> None:
        self.serve()
        self.clock.advance(1_600)
        self.readiness.invalidate_policy()
        self.assertEqual(self.payload()["lapses"], 1)

    def test_a_stalled_home_is_one_lapse_and_one_flip_however_often_it_is_asked(self) -> None:
        self.serve()
        self.clock.advance(250)
        self.readiness.note_probe_step("home_plugins")
        for _ in range(500):
            self.clock.advance(100)
            self.payload()
            self.readiness.service_audit_revision()
        payload = self.payload()
        self.assertEqual((payload["lapses"], payload["flips"]), (1, 2))
        self.assertEqual(payload["last_lapse"]["step"], "home_plugins")
        self.assertEqual(len([line for line in self.lines if line.startswith(LAPSE_LINE)]), 1)
        self.assertEqual(len([line for line in self.lines if line.startswith(FLIP_LINE)]), 2)

    def test_a_thousand_lapses_keep_one_record_and_count_them_all(self) -> None:
        for _ in range(1_000):
            self.serve()
            self.clock.advance(1_600)
            self.payload()
        payload = self.payload()
        self.assertEqual(payload["lapses"], 1_000)
        self.assertEqual(payload["flips"], 2_000)
        self.assertEqual(set(payload["last_lapse"]), {"step", "ms", "at"})
        self.assertEqual(set(payload["last_flip"]), {"to", "reason", "prior_ms", "at"})
        self.assertLess(len(json.dumps(payload)), 600)

    def test_the_node_audit_lapses_once_until_it_passes_again(self) -> None:
        for _ in range(5):
            self.readiness.note_node_audit(False, 2_100)
        self.readiness.note_node_audit(True, 30)
        self.readiness.note_node_audit(False, 2_000)
        payload = self.payload()
        self.assertEqual(payload["lapses"], 2)
        self.assertEqual((payload["last_lapse"]["step"], payload["last_lapse"]["ms"]), ("node_audit", 2_000))

    def test_a_fuse_flips_with_its_closed_reason(self) -> None:
        self.serve()
        self.readiness.note_policy_fused()
        self.assertEqual(self.payload()["last_flip"]["reason"], "policy_fused")

    def test_lines_are_printed_after_the_readiness_lock_is_released(self) -> None:
        held: list[bool] = []

        def probe_lock(line: str, err: bool = False) -> None:
            free = threading.Event()

            def take() -> None:
                if self.readiness._lock.acquire(timeout=0.5):
                    self.readiness._lock.release()
                    free.set()

            other = threading.Thread(target=take)
            other.start()
            other.join()
            held.append(not free.is_set())

        with patch.object(readiness_module, "emit", probe_lock):
            self.serve()
            self.clock.advance(POLICY_HEALTH_LEASE_NS // MS)
            self.payload()
            self.serve()
            self.readiness.begin_recovery()
        self.assertTrue(held)
        self.assertFalse(any(held))


class LapseFlipPrivacyTests(unittest.TestCase):
    """The records stay closed whatever Home's and the plugin's answers to the probe carry."""

    def test_lapse_and_flip_records_never_carry_the_probe_answers(self) -> None:
        secret = "planted-probe-secret-" + TOKEN_SENTINEL
        now = [10_000_000_000]
        lines: list[str] = []
        state = Readiness(secret, lambda: now[0])
        home_answer = {
            "plugins_enabled": True,
            "plugins": [
                {
                    "id": POLICY_PLUGIN_ID,
                    "registered": True,
                    "enabled": True,
                    "effective_enabled": True,
                    "note": secret,
                }
            ],
            "error": secret,
        }
        calls = iter([True, False])

        def plugin_answer(_path: str, body: dict[str, str], **_kwargs: object) -> tuple[int, dict[str, object]]:
            if next(calls):
                return 200, {"ok": True, "nonce": body["nonce"], "instance": "a" * 32, "error": secret}
            return 0, {"error": secret, "address": "10.0.0.9:8329"}

        with (
            patch.object(readiness_module, "emit", lambda line, err=False: lines.append(line)),
            patch.object(policy_monitor, "request_json", lambda *_a, **_k: (200, home_answer)),
            patch.object(policy_monitor, "native_policy_request", plugin_answer),
        ):
            self.assertTrue(state.refresh_policy_lease("a" * 32))
            state.set_ready(True, audit_revision=state.service_audit_revision())
            now[0] += 300_000_000
            # The first probe never sees its log line and the second loses the plugin.
            self.assertEqual(policy_monitor.probe_home_policy(secret, state)[0], "missed")
            self.assertEqual(policy_monitor.probe_home_policy(secret, state)[0], "missed")
            state.note_node_audit(False, 2_000)
            now[0] += 2_000_000_000
            _ready, payload, _lease = state.readiness_response()
        self.assertIn("last_lapse", payload)
        self.assertIn("last_flip", payload)
        rendered = json.dumps(payload) + "\n".join(lines)
        for leaked in (secret, TOKEN_SENTINEL, "10.0.0.9", "8329", "note", "error"):
            self.assertNotIn(leaked, rendered)
        for line in lines:
            name, _space, body = line.partition(" ")
            self.assertIn(name, {"POOL_READINESS_LAPSE", "POOL_READINESS_FLIP"})
            fields = json.loads(body)
            if name == "POOL_READINESS_LAPSE":
                self.assertEqual(set(fields), {"step", "ms"})
                self.assertIn(fields["step"], LAPSE_STEPS)
            else:
                self.assertEqual(set(fields), {"to", "reason", "prior_ms"})
                self.assertIn(fields["reason"], {"restored", "policy_fused", "policy_unproven", "degraded"})
            self.assertTrue(all(isinstance(value, (str, int)) for value in fields.values()))


if __name__ == "__main__":
    unittest.main()
