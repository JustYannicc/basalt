"""Fast liveness never borrows readiness from an old or failed full audit."""

import unittest
from collections.abc import Callable
from unittest.mock import Mock, patch

from . import pool_contract, service_health
from .service_health import ServiceHealth
from .readiness import Readiness
from .test_recovery import Clock


class ServiceHealthTests(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.clock = Clock()
        self.full = Mock(return_value=True)
        self.fast = Mock(return_value=True)
        self.health = ServiceHealth("fixture", "node", self.full, self.fast, self.clock)
        self.pending: list[Callable[[], None]] = []

        def thread(*, target, args, daemon):
            return Mock(start=lambda: self.pending.append(lambda: target(*args)))

        self.thread_patch = patch.object(service_health.threading, "Thread", thread)

    def setUp(self) -> None:
        self.thread_patch.start()
        self.addCleanup(self.thread_patch.stop)

    def finish_audit(self) -> None:
        self.pending.pop(0)()

    def test_thirty_fast_probes_use_one_full_audit_per_minute(self) -> None:
        for now in range(2, 62, 2):
            self.clock.now = now
            self.assertTrue(self.health.check())
        self.assertEqual(self.fast.call_count, 30)
        self.assertEqual(self.full.call_count, 0)
        self.assertEqual(len(self.pending), 1)
        self.finish_audit()
        self.full.assert_called_once_with("fixture", "node")
        self.clock.now = 62
        self.assertTrue(self.health.check())
        self.assertEqual(self.pending, [])

    def test_failed_audit_cannot_be_overwritten_by_fast_success(self) -> None:
        self.clock.now = 60
        self.health.check()
        self.full.return_value = False
        self.finish_audit()
        self.assertFalse(self.health.check())
        self.clock.now = 62
        self.assertFalse(self.health.check())
        self.full.return_value = True
        self.finish_audit()
        self.assertTrue(self.health.check())

    def test_fast_recovery_requires_a_fresh_full_contract(self) -> None:
        self.fast.return_value = False
        self.assertFalse(self.health.check())
        self.fast.return_value = True
        self.assertFalse(self.health.check())
        self.assertEqual(len(self.pending), 1)
        self.finish_audit()
        self.assertTrue(self.health.check())

    def test_readiness_invalidation_requires_a_new_audit_with_healthy_processes(self) -> None:
        self.health.invalidate()
        self.assertFalse(self.health.check())
        self.finish_audit()
        self.assertTrue(self.health.check())

    def test_unexpected_audit_error_reaches_the_existing_runtime_boundary(self) -> None:
        self.clock.now = 60
        self.health.check()
        self.full.side_effect = RuntimeError("fixture")
        self.finish_audit()
        with self.assertRaisesRegex(RuntimeError, "^fixture$"):
            self.health.check()

    def test_unexpected_audit_error_is_delivered_even_when_fast_probes_fail(self) -> None:
        self.clock.now = 60
        self.health.check()
        self.full.side_effect = RuntimeError("fixture")
        self.finish_audit()
        self.fast.return_value = False
        with self.assertRaisesRegex(RuntimeError, "^fixture$"):
            self.health.check()

    def test_policy_transition_between_ticks_cannot_restore_cached_readiness(self) -> None:
        ready = Readiness("fixture", lambda: int(self.clock.now * 1_000_000_000))
        ready.refresh_policy_lease("a" * 32)
        revision = ready.service_audit_revision()
        ready.set_ready(True, audit_revision=revision)
        self.assertTrue(ready.snapshot()[0])
        ready.invalidate_policy()
        ready.refresh_policy_lease("a" * 32)
        self.assertFalse(ready.snapshot()[0])
        self.assertNotEqual(ready.service_audit_revision(), revision)
        self.health.invalidate()
        revision = ready.service_audit_revision()
        ready.set_ready(self.health.check(), audit_revision=revision)
        self.assertFalse(ready.snapshot()[0])
        self.finish_audit()
        ready.set_ready(self.health.check(), audit_revision=revision)
        self.assertTrue(ready.snapshot()[0])
        ready.invalidate_policy()
        ready.refresh_policy_lease("a" * 32)
        ready.set_ready(True, audit_revision=revision)
        self.assertFalse(ready.snapshot()[0])

    def test_expired_policy_lease_between_ticks_invalidates_the_full_contract(self) -> None:
        ready = Readiness("fixture", lambda: int(self.clock.now * 1_000_000_000))
        ready.refresh_policy_lease("a" * 32)
        revision = ready.service_audit_revision()
        ready.set_ready(True, audit_revision=revision)
        self.clock.now = 2
        ready.refresh_policy_lease("a" * 32)
        self.assertFalse(ready.snapshot()[0])
        ready.set_ready(True, audit_revision=revision)
        self.assertFalse(ready.snapshot()[0])

    def test_result_started_before_fast_failure_cannot_restore_readiness(self) -> None:
        self.clock.now = 60
        self.health.check()
        self.fast.return_value = False
        self.assertFalse(self.health.check())
        self.fast.return_value = True
        self.assertFalse(self.health.check())
        self.finish_audit()
        self.assertFalse(self.health.check())
        self.finish_audit()
        self.assertTrue(self.health.check())

    def test_audit_deadline_fails_closed_without_blocking_probes(self) -> None:
        self.clock.now = 60
        self.assertTrue(self.health.check())
        self.clock.now = 64
        self.assertFalse(self.health.check())
        self.assertEqual(len(self.pending), 1)
        self.assertEqual(self.fast.call_count, 2)

    def test_late_audit_success_never_restores_readiness(self) -> None:
        self.clock.now = 60
        self.assertTrue(self.health.check())
        self.clock.now = 64
        self.assertFalse(self.health.check())
        self.clock.now = 65
        self.finish_audit()
        self.assertFalse(self.health.check())
        self.clock.now = 67
        self.assertFalse(self.health.check())
        self.finish_audit()
        self.assertTrue(self.health.check())

    def test_old_home_generation_cannot_update_new_generation(self) -> None:
        self.clock.now = 60
        self.health.check()
        new_fast = Mock(return_value=False)
        replacement = ServiceHealth("fixture", "new-node", self.full, new_fast, self.clock)
        self.assertFalse(replacement.check())
        self.finish_audit()
        new_fast.return_value = True
        self.assertFalse(replacement.check())
        self.finish_audit()
        self.assertTrue(replacement.check())
        self.assertEqual(self.full.call_args.args, ("fixture", "new-node"))

    def test_blocked_audit_leaves_the_fast_probe_path_free(self) -> None:
        self.thread_patch.stop()
        entered = service_health.threading.Event()
        release = service_health.threading.Event()
        finished = service_health.threading.Event()

        def blocked(*_):
            entered.set()
            try:
                if not release.wait(2):
                    raise AssertionError("test did not release audit")
                return True
            finally:
                finished.set()

        health = ServiceHealth("fixture", "node", blocked, self.fast, self.clock)
        self.clock.now = 60
        try:
            self.assertTrue(health.check())
            self.assertTrue(entered.wait(1))
            self.assertTrue(health.check())
            self.clock.now = 64
            self.assertFalse(health.check())
        finally:
            release.set()
            self.assertTrue(finished.wait(1))


class FastProbeTests(unittest.TestCase):
    def test_fast_probe_never_requests_database_backed_management(self) -> None:
        with patch.object(pool_contract, "request_json", return_value=(200, {"status": "ok"})) as request:
            self.assertTrue(pool_contract.check_liveness("fixture"))
        self.assertEqual(
            [call.args[0] for call in request.call_args_list],
            [f"{pool_contract.NODE_URL}/healthz", f"{pool_contract.HOME_URL}/healthz"],
        )

    def test_fast_probe_rejects_failed_or_malformed_home_response(self) -> None:
        for response in [(503, {"status": "ok"}), (200, {}), (200, {"status": "no"})]:
            with self.subTest(response=response), patch.object(
                pool_contract, "request_json", side_effect=[(200, {"status": "ok"}), response]
            ):
                self.assertFalse(pool_contract.check_liveness("fixture"))
