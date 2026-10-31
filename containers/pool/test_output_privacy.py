"""Exercise both collected streams through supervisor and HTTP failure paths."""

from __future__ import annotations

import http.client
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import patch

from . import readiness, supervisor
from .pool_contract import StartupError


RESPONSE_SENTINEL = "private-response-sentinel"
TOKEN_SENTINEL = "private-token-sentinel"
CLASS_SENTINEL = "PrivateExceptionSentinel"
STARTUP_PHASE_NAMES = (
    "home_boot",
    "bootstrap_import",
    "config_apply",
    "node_launch",
    "initial_health",
)
MAX_STARTUP_PHASE_MS = 86_400_000


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate startup phase field")
        value[key] = item
    return value


class OutputPrivacyTests(unittest.TestCase):
    def assert_startup_phases(self, stdout: str, expected: list[str]) -> None:
        lines = stdout.splitlines()
        self.assertEqual(len(lines), len(expected), "unexpected supervisor stdout line count")
        observed = []
        fields = ("phase", "start_ms", "end_ms", "duration_ms")
        for line in lines:
            try:
                marker, payload = line.split(" ", 1)
            except ValueError:
                self.fail("supervisor stdout did not use the startup phase marker")
            self.assertEqual(marker, "POOL_STARTUP_PHASE")
            try:
                record = json.loads(payload, object_pairs_hook=unique_json_object)
            except (TypeError, ValueError):
                self.fail("startup phase payload was not valid JSON")
            self.assertIs(type(record), dict)
            self.assertEqual(len(record), len(fields), "startup phase schema changed")
            self.assertTrue(all(field in record for field in fields), "startup phase fields changed")
            phase = record["phase"]
            self.assertTrue(
                type(phase) is str and phase in STARTUP_PHASE_NAMES,
                "startup phase name was outside the closed enum",
            )
            measurements = [record[field] for field in fields[1:]]
            self.assertTrue(
                all(
                    type(value) is int and 0 <= value <= MAX_STARTUP_PHASE_MS
                    for value in measurements
                ),
                "startup phase measurements were outside the integer bound",
            )
            start_ms, end_ms, duration_ms = measurements
            self.assertTrue(
                end_ms >= start_ms and duration_ms == end_ms - start_ms,
                "startup phase duration did not match its monotonic offsets",
            )
            observed.append(phase)
        self.assertTrue(observed == expected, "startup phase sequence changed")

    def assert_closed_output(
        self,
        stdout: str,
        stderr: str,
        categories: list[int],
        startup_phases: list[str] | None = None,
    ) -> None:
        for value in (RESPONSE_SENTINEL, TOKEN_SENTINEL, CLASS_SENTINEL):
            self.assertNotIn(value, stdout + stderr)
        self.assert_startup_phases(stdout, startup_phases or [])
        lines = stderr.splitlines()
        self.assertEqual(len(lines), len(categories))
        observed = []
        for line in lines:
            marker, payload = line.split(" ", 1)
            self.assertEqual(marker, "POOL_RUNTIME_FAILURE")
            value = json.loads(payload)
            self.assertEqual(set(value), {"category", "count"})
            self.assertIs(type(value["category"]), int)
            self.assertIs(type(value["count"]), int)
            self.assertEqual(value["count"], 1)
            observed.append(value["category"])
        self.assertCountEqual(observed, categories)

    def capture_supervisor_failure(self, error: Exception) -> tuple[str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.object(supervisor, "env_required", side_effect=error),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            self.assertEqual(supervisor.main(), 1)
        return stdout.getvalue(), stderr.getvalue()

    def test_supervisor_startup_errors_are_closed(self) -> None:
        output = self.capture_supervisor_failure(
            StartupError(f"{RESPONSE_SENTINEL} Authorization: Bearer {TOKEN_SENTINEL}")
        )
        self.assert_closed_output(*output, [1])

    def test_supervisor_exception_names_are_closed(self) -> None:
        private_error = type(CLASS_SENTINEL, (Exception,), {})
        output = self.capture_supervisor_failure(
            private_error(f"{RESPONSE_SENTINEL} {TOKEN_SENTINEL}")
        )
        self.assert_closed_output(*output, [1])

    def test_supervisor_post_readiness_runtime_failure_is_closed(self) -> None:
        # Exercise main's phase transition after its startup dependencies succeed.
        stdout, stderr = io.StringIO(), io.StringIO()
        child = SimpleNamespace(process=SimpleNamespace(poll=lambda: None))
        failure = StartupError(f"{RESPONSE_SENTINEL} Authorization: Bearer {TOKEN_SENTINEL}")

        class HealthyPolicyMonitor:
            def __init__(self, _ready: readiness.Readiness, _management_key: str) -> None:
                pass

            def run(self, stop: Any) -> None:
                stop.wait()

        def start_ready_server(ready: readiness.Readiness) -> None:
            if not ready.refresh_policy_lease("a" * 32):
                raise AssertionError("fixture could not establish the policy lease")

        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(supervisor, "ROOT", pathlib.Path(root)),
            patch.object(supervisor, "env_required", return_value=TOKEN_SENTINEL),
            patch.object(supervisor, "require_tmpfs"),
            patch.object(supervisor, "start_ready_server", side_effect=start_ready_server),
            patch.object(supervisor, "PolicyHealthMonitor", HealthyPolicyMonitor),
            patch.object(supervisor, "child_environment", return_value={}),
            patch.object(supervisor, "Child", return_value=child),
            patch.object(supervisor, "wait_for_home", return_value="ready"),
            patch.object(supervisor, "apply_pool_config"),
            patch.object(supervisor, "create_node_jwt", return_value=("fixture-node", TOKEN_SENTINEL)),
            patch.object(supervisor, "check_services", side_effect=[True, failure]) as health,
            patch.object(supervisor, "terminate_children"),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            self.assertEqual(supervisor.main(), 1)
            self.assertEqual(health.call_count, 2)
        self.assert_closed_output(
            stdout.getvalue(),
            stderr.getvalue(),
            [5],
            ["home_boot", "config_apply", "node_launch", "initial_health"],
        )

    def test_startup_phase_record_uses_bounded_monotonic_offsets(self) -> None:
        from . import runtime_signals

        stdout = io.StringIO()
        with (
            patch.object(
                runtime_signals.time,
                "monotonic_ns",
                side_effect=[1_000_000_000, 1_025_999_999],
            ),
            redirect_stdout(stdout),
            self.assertRaises(StartupError),
        ):
            with runtime_signals.startup_phase(
                runtime_signals.StartupPhase.HOME_BOOT,
                950_000_000,
            ):
                raise StartupError(f"{RESPONSE_SENTINEL} {TOKEN_SENTINEL}")

        output = stdout.getvalue()
        self.assert_closed_output(output, "", [], ["home_boot"])
        record = json.loads(output.split(" ", 1)[1])
        self.assertEqual(
            (record["start_ms"], record["end_ms"], record["duration_ms"]),
            (50, 75, 25),
        )

    def test_startup_phase_rejects_invalid_or_unbounded_records(self) -> None:
        from . import runtime_signals

        stdout = io.StringIO()
        with redirect_stdout(stdout):
            runtime_signals.report_startup_phase(
                cast(runtime_signals.StartupPhase, cast(object, "home_boot")),
                0,
                1,
            )
            runtime_signals.report_startup_phase(runtime_signals.StartupPhase.HOME_BOOT, True, 1)
            runtime_signals.report_startup_phase(
                runtime_signals.StartupPhase.HOME_BOOT,
                0,
                MAX_STARTUP_PHASE_MS + 1,
            )
            runtime_signals.report_startup_phase(runtime_signals.StartupPhase.HOME_BOOT, 2, 1)
        self.assertEqual(stdout.getvalue(), "")

        with (
            patch.object(runtime_signals.time, "monotonic_ns", side_effect=OSError),
            redirect_stdout(stdout),
        ):
            with runtime_signals.startup_phase(runtime_signals.StartupPhase.HOME_BOOT, 0):
                pass
        self.assertEqual(stdout.getvalue(), "")

    def test_http_handler_failure_cannot_print_response_token_or_address(self) -> None:
        class ExplodingHandler(readiness.ReadyHandler):
            def _send(
                self,
                status: int,
                payload: dict[str, Any],
                extra_headers: dict[str, str] | None = None,
            ) -> None:
                raise RuntimeError(f"{RESPONSE_SENTINEL} {TOKEN_SENTINEL}")

        stdout, stderr = io.StringIO(), io.StringIO()
        with (
            patch.object(readiness, "READY_BIND", ("127.0.0.1", 0)),
            patch.object(readiness, "ReadyHandler", ExplodingHandler),
            redirect_stdout(stdout),
            redirect_stderr(stderr),
        ):
            server = readiness.start_ready_server(readiness.Readiness(TOKEN_SENTINEL))
            try:
                request = urllib.request.Request(
                    f"http://127.0.0.1:{server.server_port}/ready",
                    headers={"Authorization": f"Bearer {TOKEN_SENTINEL}"},
                )
                with self.assertRaises(http.client.RemoteDisconnected):
                    urllib.request.urlopen(request, timeout=3)
            finally:
                server.shutdown()
                server.server_close()
        self.assertNotIn("127.0.0.1", stdout.getvalue() + stderr.getvalue())
        self.assert_closed_output(stdout.getvalue(), stderr.getvalue(), [8])

    def test_entrypoint_closes_thread_unraisable_and_cleanup_tracebacks(self) -> None:
        # Run the real entrypoint so this also catches a missing hook installation.
        program = '''
import runpy
import threading
from containers.pool import pool_contract

class PrivateExceptionSentinel(Exception):
    pass

def fail():
    raise PrivateExceptionSentinel("private-response-sentinel private-token-sentinel")

class BadFinalizer:
    def __del__(self):
        fail()

def fail_configuration(name):
    thread = threading.Thread(target=fail)
    thread.start()
    thread.join()
    finalizer = BadFinalizer()
    del finalizer
    raise pool_contract.StartupError("private-response-sentinel private-token-sentinel")

class BrokenCleanup:
    def __truediv__(self, name):
        return self
    def unlink(self, **kwargs):
        fail()

pool_contract.env_required = fail_configuration
pool_contract.ROOT = BrokenCleanup()
runpy.run_module("containers.pool.supervisor", run_name="__main__")
'''
        result = subprocess.run(
            [sys.executable, "-c", program],
            cwd=pathlib.Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assert_closed_output(result.stdout, result.stderr, [7, 9, 1, 6])


if __name__ == "__main__":
    unittest.main()
