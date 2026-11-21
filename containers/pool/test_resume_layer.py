from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from . import pool_contract
from .readiness import Readiness
from .resume_layer import FIRST_BACKOFF_SECONDS, MAX_BACKOFF_SECONDS, STABLE_SECONDS, ResumeLayer


class FakeProcess:
    def __init__(self) -> None:
        self.exit_code: int | None = None

    def poll(self) -> int | None:
        return self.exit_code


class Harness:
    def __init__(self) -> None:
        self.now = 100.0
        self.healthy = False
        self.spawned: list[SimpleNamespace] = []
        self.exits: list[int] = []
        self.spawn_error: OSError | None = None
        self.layer = ResumeLayer(self._spawn, self._report, lambda: self.now)

    def tick(self) -> bool:
        # The supervisor's order: reap or start, then probe only a running layer.
        running = self.layer.tick()
        return self.layer.observe_health(running and self.healthy)

    def _spawn(self) -> SimpleNamespace:
        if self.spawn_error is not None:
            raise self.spawn_error
        child = SimpleNamespace(name="resume", process=FakeProcess())
        self.spawned.append(child)
        return child

    def _report(self, child: SimpleNamespace, exit_code: int) -> None:
        self.exits.append(exit_code)

    def crash(self, exit_code: int = 2) -> None:
        self.spawned[-1].process.exit_code = exit_code


class ResumeLayerTests(unittest.TestCase):
    def test_resume_is_advertised_only_after_the_layer_answers_health(self) -> None:
        h = Harness()
        self.assertFalse(h.tick())
        self.assertEqual(len(h.spawned), 1)
        self.assertFalse(h.tick())
        h.healthy = True
        self.assertTrue(h.tick())
        h.healthy = False
        self.assertFalse(h.tick())

    def test_an_exit_withdraws_resume_reports_once_and_restarts_alone_after_backoff(self) -> None:
        h = Harness()
        h.tick()
        h.healthy = True
        self.assertTrue(h.tick())
        h.crash(2)
        self.assertFalse(h.tick())
        self.assertEqual(h.exits, [2])
        h.now += FIRST_BACKOFF_SECONDS - 0.01
        self.assertFalse(h.tick())
        self.assertEqual(len(h.spawned), 1)
        h.now += 0.02
        h.tick()
        self.assertEqual(len(h.spawned), 2)
        self.assertEqual(h.exits, [2])
        self.assertTrue(h.tick())

    def test_a_crash_loop_backs_off_to_the_cap_and_never_raises(self) -> None:
        h = Harness()
        delays = []
        for _ in range(10):
            h.tick()
            h.crash()
            started = h.now
            h.tick()
            while len(h.spawned) == len(delays) + 1:
                h.now += 0.5
                h.tick()
            delays.append(h.now - started)
        self.assertLessEqual(max(delays), MAX_BACKOFF_SECONDS + 0.5)
        self.assertGreaterEqual(delays[-1], MAX_BACKOFF_SECONDS)
        self.assertEqual(len(h.exits), 10)

    def test_a_stable_layer_earns_a_fresh_backoff(self) -> None:
        h = Harness()
        for _ in range(4):
            h.tick()
            h.crash()
            h.tick()
            h.now += MAX_BACKOFF_SECONDS
        h.tick()
        h.healthy = True
        h.tick()
        h.now += STABLE_SECONDS
        h.tick()
        h.crash()
        h.tick()
        h.now += FIRST_BACKOFF_SECONDS
        h.tick()
        self.assertEqual(len(h.spawned), 6)

    def test_a_failed_spawn_is_retried_without_raising(self) -> None:
        h = Harness()
        h.spawn_error = OSError("exec format error")
        self.assertFalse(h.tick())
        h.spawn_error = None
        h.now += FIRST_BACKOFF_SECONDS
        h.tick()
        self.assertEqual(len(h.spawned), 1)

    def test_the_health_probe_never_raises(self) -> None:
        with patch.object(pool_contract, "request_json", side_effect=TimeoutError("probe")):
            self.assertFalse(pool_contract.resume_layer_healthy())
        with patch.object(pool_contract, "request_json", return_value=(200, {"status": "ok"})):
            self.assertTrue(pool_contract.resume_layer_healthy())


class ReadinessResumeTests(unittest.TestCase):
    def test_ready_names_resume_only_while_the_layer_is_available(self) -> None:
        readiness = Readiness("k" * 32)
        self.assertNotIn("resume", readiness.snapshot()[1])
        readiness.set_resume_available(True)
        self.assertEqual(readiness.snapshot()[1]["resume"], "v1")
        readiness.set_resume_available(False)
        self.assertNotIn("resume", readiness.snapshot()[1])


if __name__ == "__main__":
    unittest.main()
