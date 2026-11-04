"""Supervisor replacement-generation behavior through its real main loop."""

from __future__ import annotations

import io
import json
import pathlib
import signal
import tempfile
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
    ):
        clock = Clock()
        stop = Stop(clock)
        output, errors = io.StringIO(), io.StringIO()
        launched = []
        ready_instances = []
        handlers = {}
        terminations = []
        boot_ids = []

        def make_child(name, command, env, cwd, *callbacks):
            number = sum(child.name == "home" for child in launched)
            # Each generation serves once, then its selected process exits.
            calls = 0

            def poll():
                nonlocal calls
                calls += 1
                if name == failed_name and (fail_initial or calls > 1):
                    return code
                return None

            child = SimpleNamespace(name=name, process=SimpleNamespace(poll=poll))
            launched.append(child)
            if name == "home" and empty_recovery and number > 0:
                child.empty = True
            return child

        def ready_server(ready):
            ready_instances.append(ready)
            ready.refresh_policy_lease("a" * 32)

        def health(*args):
            ready = ready_instances[0]
            if fuse:
                ready.note_policy_fused()
            else:
                ready.refresh_policy_lease("b" * 32, ready.generation())
            boot_ids.append(ready.generation())
            return True

        def advance_phase(phase):
            if sum(child.name == "home" for child in launched) > 1:
                clock.now += (recovery_phase_delays or {}).get(phase, 0)

        def wait_home(child, *args):
            advance_phase("home")
            return "empty" if getattr(child, "empty", False) else "ready"

        def enroll(*args):
            advance_phase("enroll")
            return "node", "jwt"

        def wait_callback(seconds):
            if stop_after_recovery and seconds == 2 and len(boot_ids) == 2:
                self.assertTrue(ready_instances[0].snapshot()[0])
                stop.set()
            if cancel_backoff and seconds == 1:
                handlers[signal.SIGTERM](signal.SIGTERM, None)

        stop.on_wait = wait_callback
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
                "PolicyHealthMonitor": Mock(
                    return_value=SimpleNamespace(run=lambda _: None)
                ),
                "terminate_children": lambda children: terminations.append(
                    [c.name for c in children]
                ),
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
