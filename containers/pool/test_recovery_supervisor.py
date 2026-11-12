"""Supervisor replacement-generation behavior through its real main loop."""

from __future__ import annotations

import io
import json
import pathlib
import signal
import subprocess
import tempfile
import threading
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from . import supervisor
from .test_recovery import Clock, Stop


class SupervisorTests(unittest.TestCase):
    def run_supervisor(
        self,
        *,
        failed_name="home",
        code=1,
        fail_initial=False,
        stop_after_recovery=False,
        cancel_backoff=False,
        empty_recovery=False,
        fuse=False,
        recovery_phase_delays=None,
        buffered_fuse=False,
        stuck_reader=False,
        actual_cleanup=False,
        replacement_startup_exit=False,
        replacement_drain_failure=None,
        invalidate_startup_audit=False,
    ):
        clock = Clock()
        stop = Stop(clock)
        output, errors = io.StringIO(), io.StringIO()
        launched = []
        ready_instances = []
        handlers = {}
        terminations = []
        boot_ids = []
        terminate_owned = supervisor.terminate_children
        wait_for_home = supervisor.wait_for_home
        service_health = supervisor.ServiceHealth
        transition_samples = []

        def make_child(name, command, env, cwd, *callbacks):
            number = sum(child.name == "home" for child in launched)
            # Each generation serves once, then its selected process exits.
            calls = 0
            killed = False

            def poll():
                nonlocal calls
                calls += 1
                if killed:
                    return -9
                if replacement_startup_exit and name == "home" and number > 0:
                    return code
                if actual_cleanup and number > 0:
                    return None
                if name == failed_name and (fail_initial or calls > 1):
                    return code
                return None

            def kill():
                nonlocal killed
                killed = True

            def wait(timeout):
                if (
                    replacement_startup_exit
                    and name == "home"
                    and number > 0
                    and replacement_drain_failure == "deadline"
                ):
                    clock.now += timeout
                if actual_cleanup and not killed and (name == "node" or number > 0):
                    clock.now += timeout
                    raise subprocess.TimeoutExpired(name, timeout)
                return -9 if killed else code

            child = SimpleNamespace(
                name=name,
                process=SimpleNamespace(
                    poll=poll,
                    wait=wait,
                    returncode=code,
                    terminate=lambda: None,
                    kill=kill,
                ),
                config_empty=threading.Event(),
            )
            if name == "home":

                def drain(timeout):
                    if buffered_fuse:
                        callbacks[0]()

                child._reader = SimpleNamespace(
                    join=drain,
                    is_alive=lambda: (
                        stuck_reader
                        or (
                            replacement_startup_exit
                            and number > 0
                            and replacement_drain_failure == "unfinished"
                        )
                    ),
                )
            launched.append(child)
            if name == "home" and empty_recovery and number > 0:
                child.empty = True
            return child

        def ready_server(ready):
            ready_instances.append(ready)
            ready.refresh_policy_lease("b" * 32)

        def health(*args):
            ready = ready_instances[0]
            if fuse:
                ready.note_policy_fused()
            else:
                ready.refresh_policy_lease("b" * 32, ready.generation())
            boot_ids.append(ready.generation())
            return True

        def make_service_health(*args):
            if invalidate_startup_audit:
                ready_instances[0].invalidate_policy()
                ready_instances[0].refresh_policy_lease("b" * 32)
            return service_health(*args)

        def advance_phase(phase):
            if sum(child.name == "home" for child in launched) > 1:
                clock.now += (recovery_phase_delays or {}).get(phase, 0)

        def wait_home(child, *args):
            advance_phase("home")
            if replacement_startup_exit and sum(c.name == "home" for c in launched) > 1:
                if replacement_drain_failure == "deadline":
                    from .recovery_deadline import operation_timeout

                    clock.now += operation_timeout(180) - 0.5
                return wait_for_home(child, *args)
            return "empty" if getattr(child, "empty", False) else "ready"

        def enroll(*args):
            advance_phase("enroll")
            return "node", "jwt"

        def wait_callback(seconds):
            if invalidate_startup_audit and seconds == 2:
                transition_samples.append(ready_instances[0].snapshot()[0])
                if len(transition_samples) == 2:
                    stop.set()
            if stop_after_recovery and seconds == 2 and len(boot_ids) == 2:
                self.assertTrue(ready_instances[0].snapshot()[0])
                stop.set()
            if cancel_backoff and seconds == 1:
                handlers[signal.SIGTERM](signal.SIGTERM, None)

        stop.on_wait = wait_callback

        def terminate_generation(children):
            terminations.append([c.name for c in children])
            if actual_cleanup:
                terminate_owned(children)

        with ExitStack() as stack:
            root = stack.enter_context(tempfile.TemporaryDirectory())
            mocks = {
                "ROOT": pathlib.Path(root),
                "env_required": Mock(return_value="fixture"),
                "require_tmpfs": Mock(),
                "child_environment": Mock(return_value={}),
                "start_ready_server": ready_server,
                "Child": make_child,
                "wait_for_home": wait_home,
                "apply_pool_config": lambda *_: advance_phase("config"),
                "create_node_jwt": enroll,
                "check_services": health,
                "check_liveness": health,
                "ServiceHealth": make_service_health,
                "PolicyHealthMonitor": Mock(
                    return_value=SimpleNamespace(run=lambda _: None)
                ),
                "terminate_children": terminate_generation,
                "import_initial_config": Mock(),
            }
            for name, value in mocks.items():
                stack.enter_context(patch.object(supervisor, name, value))
            stack.enter_context(patch.object(supervisor.time, "monotonic", clock))
            stack.enter_context(
                patch.object(
                    supervisor.signal,
                    "signal",
                    side_effect=lambda key, fn: handlers.setdefault(key, fn),
                )
            )
            stack.enter_context(redirect_stdout(output))
            stack.enter_context(redirect_stderr(errors))
            result = supervisor.main(stop)
            ready_instances[0].cleanup_finished_at = clock.now
            ready_instances[0].transition_samples = transition_samples
            imported = mocks["import_initial_config"].call_count
        records = [
            (line.split(" ", 1)[0], json.loads(line.split(" ", 1)[1]))
            for line in errors.getvalue().splitlines()
        ]
        return (
            result,
            launched,
            ready_instances[0],
            records,
            stop,
            terminations,
            boot_ids,
            imported,
        )

    def test_invalidation_after_startup_audit_is_not_adopted_as_cached_proof(self):
        result, _, ready, _, _, _, _, _ = self.run_supervisor(
            failed_name="none", invalidate_startup_audit=True
        )
        self.assertEqual(result, 0)
        self.assertEqual(ready.transition_samples, [False, False])

    def test_repeated_runtime_failures_exit_one_with_receipts_and_no_budget_reset(self):
        result, children, ready, records, _stop, terminations, ids, _ = (
            self.run_supervisor()
        )
        self.assertEqual(result, 1)
        self.assertEqual([c.name for c in children], ["home", "node"] * 3)
        self.assertEqual(
            [r[1]["state"] for r in records if r[0] == "POOL_HOME_RECOVERY"],
            ["attempt", "recovered", "attempt", "recovered", "exhausted"],
        )
        self.assertEqual(
            [r[1]["exit_code"] for r in records if r[0] == "POOL_CHILD_EXIT"], [1, 1, 1]
        )
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)
        self.assertEqual(len(set(ids)), 3)
        self.assertEqual(terminations[:2], [["home", "node"], ["home", "node"]])
        self.assertFalse(ready.snapshot()[0])

    def test_one_transient_failure_recovers_then_shuts_down_cleanly(self):
        result, children, _ready, records, _, _, ids, _ = self.run_supervisor(
            stop_after_recovery=True
        )
        self.assertTrue(
            any(
                marker == "POOL_HOME_RECOVERY" and row["state"] == "recovered"
                for marker, row in records
            )
        )
        self.assertEqual(result, 0)
        self.assertEqual(len(children), 4)
        self.assertFalse(any(marker == "POOL_RUNTIME_FAILURE" for marker, _ in records))
        self.assertEqual(len(set(ids)), 2)

    def test_initial_failure_node_failure_signal_and_fuse_do_not_recover(self):
        for options in (
            {"fail_initial": True},
            {"failed_name": "node"},
            {"code": -9},
            {"code": 0},
            {"fuse": True},
        ):
            with self.subTest(options=options):
                result, children, _, records, *_ = self.run_supervisor(**options)
                self.assertEqual(result, 1)
                self.assertEqual(len(children), 2)
                self.assertFalse(
                    any(marker == "POOL_HOME_RECOVERY" for marker, _ in records)
                )

    def test_sigterm_in_backoff_cancels_recovery_and_prevents_replacement(self):
        result, children, ready, records, stop, *_ = self.run_supervisor(
            cancel_backoff=True
        )
        self.assertEqual(result, 0)
        self.assertEqual(len(children), 2)
        self.assertFalse(ready.snapshot()[0])
        self.assertFalse(any(marker == "POOL_RUNTIME_FAILURE" for marker, _ in records))
        self.assertTrue(stop.is_set())

    def test_empty_config_during_recovery_never_bootstraps(self):
        result, children, _, records, *_, imported = self.run_supervisor(
            empty_recovery=True
        )
        self.assertEqual(result, 1)
        self.assertEqual(len(children), 3)
        self.assertEqual(imported, 0)
        exits = [row for marker, row in records if marker == "POOL_CHILD_EXIT"]
        self.assertEqual([row["child"] for row in exits], ["home", "home"])
        self.assertEqual([row["exit_code"] for row in exits], [1, 1])
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)

    def test_episode_deadline_does_not_reset_between_home_config_and_enrollment(self):
        result, children, ready, records, *_ = self.run_supervisor(
            recovery_phase_delays={"home": 80, "config": 60, "enroll": 40},
        )
        self.assertEqual(result, 1)
        self.assertEqual([child.name for child in children], ["home", "node", "home"])
        self.assertFalse(ready.snapshot()[0])
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)
        exhausted = [
            row
            for marker, row in records
            if marker == "POOL_HOME_RECOVERY" and row["state"] == "exhausted"
        ]
        self.assertEqual(
            exhausted,
            [
                {
                    "state": "exhausted",
                    "attempt": 1,
                    "delay_seconds": 0,
                    "elapsed_ms": 180000,
                }
            ],
        )

    def test_buffered_fuse_is_observed_before_generation_rotation(self):
        result, children, ready, records, *_, ids, _ = self.run_supervisor(
            buffered_fuse=True
        )
        self.assertEqual(result, 1)
        self.assertEqual(len(children), 2)
        self.assertTrue(ready.policy_fused())
        self.assertEqual(ready.generation(), ids[0])
        self.assertFalse(
            any(
                marker == "POOL_HOME_RECOVERY" and row["state"] == "attempt"
                for marker, row in records
            )
        )
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)

    def test_unfinished_old_reader_fails_closed_before_replacement(self):
        result, children, ready, records, *_ = self.run_supervisor(stuck_reader=True)
        self.assertEqual(result, 1)
        self.assertEqual(len(children), 2)
        self.assertFalse(ready.snapshot()[0])
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)

    def test_main_exhaustion_does_not_start_fresh_cleanup_grace(self):
        result, children, ready, records, _, terminations, *_ = self.run_supervisor(
            actual_cleanup=True,
            recovery_phase_delays={"home": 80, "config": 83},
        )
        self.assertEqual(result, 1)
        # One initial teardown and one terminal cleanup, with no third finally teardown.
        self.assertEqual(len(terminations), 2)
        self.assertLessEqual(ready.cleanup_finished_at, 182)
        self.assertEqual(len(children), 3)
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)

    def test_replacement_startup_drain_failure_preserves_its_exit_receipt(self):
        for failure in ("unfinished", "deadline"):
            with self.subTest(failure=failure):
                result, children, ready, records, *_ = self.run_supervisor(
                    replacement_startup_exit=True,
                    replacement_drain_failure=failure,
                )
                self.assertEqual(result, 1)
                self.assertEqual(
                    [child.name for child in children], ["home", "node", "home"]
                )
                self.assertFalse(ready.snapshot()[0])
                exits = [row for marker, row in records if marker == "POOL_CHILD_EXIT"]
                self.assertEqual(
                    exits,
                    [
                        {"child": "home", "exit_code": 1, "category": 5},
                        {"child": "home", "exit_code": 1, "category": 2},
                    ],
                )
                self.assertIn(
                    ("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records
                )
                attempts = [
                    row
                    for marker, row in records
                    if marker == "POOL_HOME_RECOVERY" and row["state"] == "attempt"
                ]
                self.assertEqual(len(attempts), 1)

    def test_successful_replacement_drains_do_not_duplicate_exit_receipts(self):
        result, children, ready, records, *_ = self.run_supervisor(
            replacement_startup_exit=True
        )
        self.assertEqual(result, 1)
        self.assertEqual(
            [child.name for child in children], ["home", "node", "home", "home"]
        )
        exits = [row for marker, row in records if marker == "POOL_CHILD_EXIT"]
        self.assertEqual([row["exit_code"] for row in exits], [1, 1, 1])
        self.assertEqual([row["category"] for row in exits], [5, 2, 2])
        self.assertFalse(ready.snapshot()[0])

    def test_deadline_expiring_in_first_startup_drain_retains_receipt(self):
        result, children, ready, records, *_ = self.run_supervisor(
            replacement_startup_exit=True,
            replacement_drain_failure="deadline",
        )
        self.assertEqual(result, 1)
        self.assertEqual([child.name for child in children], ["home", "node", "home"])
        self.assertFalse(ready.snapshot()[0])
        self.assertEqual(
            [row for marker, row in records if marker == "POOL_CHILD_EXIT"],
            [
                {"child": "home", "exit_code": 1, "category": 5},
                {"child": "home", "exit_code": 1, "category": 2},
            ],
        )
        self.assertIn(("POOL_RUNTIME_FAILURE", {"category": 5, "count": 1}), records)
        self.assertEqual(
            [row["state"] for marker, row in records if marker == "POOL_HOME_RECOVERY"],
            ["attempt", "exhausted"],
        )
