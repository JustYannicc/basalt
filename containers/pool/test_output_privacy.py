"""Exercise both collected streams through supervisor and HTTP failure paths."""

from __future__ import annotations

import http.client
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
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
    @staticmethod
    def home_log(message: str, level: str = "fatal") -> str:
        return ("[CLIProxyAPIHome] [2026-11-04 12:00:00] [--------] "
            f"[{level}] [main.go:123] {message}")

    def home_exit(self, lines: list[str], secret: str = "fixture!", stream: str = "stdout"):
        program = "import sys; " + "; ".join(
            f"print({line!r}, file=sys.{stream}, flush=True)" for line in lines
        ) + "; sys.exit(1)"
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            child = supervisor.Child("home", [sys.executable, "-c", program],
                {**os.environ, "MANAGEMENT_PASSWORD": secret}, pathlib.Path.cwd())
            try:
                child.process.wait(timeout=5)
                child._reader.join(timeout=1)
                self.assertFalse(child._reader.is_alive(), "child output was not drained")
                self.assertIsNotNone(child.diagnostics)
                snapshot = child.diagnostics.snapshot() if child.diagnostics is not None else []
                with self.assertRaises(StartupError):
                    supervisor.wait_for_home(child, secret, threading.Event())
            finally:
                if child.process.stdout is not None:
                    child.process.stdout.close()
        marker, payload = stderr.getvalue().strip().split(" ", 1)
        self.assertEqual(marker, "POOL_CHILD_EXIT")
        return snapshot, json.loads(payload), stdout.getvalue(), stderr.getvalue()

    def test_home_stdout_and_recognized_startup_errors_survive_projection(self) -> None:
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                message = "failed to open database: connection refused"
                snapshot, receipt, stdout, _ = self.home_exit([self.home_log(message)], stream=stream)
                self.assertIn("POOL_HOME_INIT_FAILURE", stdout)
                self.assertEqual(snapshot, ["fatal: " + message])
                self.assertEqual(receipt["output_tail"], snapshot)

    def test_real_home_child_drops_cookie_nested_and_quoted_credentials(self) -> None:
        payloads = [
            '{"cookie":"session=short-cookie"}',
            '{"credentials":{"value":"short-pass!"}}',
            r'{\"credentials\":{\"value\":\"escaped-short-pass!\"}}',
            'credential rejected: "quoted-short-pass!"',
            "credential rejected: 'single-quoted-pass!'",
            "credential rejected: `backtick-pass!`",
            "credential rejected: “curly-quoted-pass!”",
            "credential rejected: ‘curly-single-pass!’",
            "cookie=session=short-cookie",
            "credentials = short-pass!",
            "%7b%22cookie%22%3a%22session%3dshort-cookie%22%7d",
        ]
        for payload in payloads:
            with self.subTest(payload=payload):
                reason = "cluster coordinator error: connection refused"
                lines = [payload, self.home_log(payload), self.home_log(reason)]
                snapshot, receipt, stdout, stderr = self.home_exit(lines)
                for value in ("short-cookie", "short-pass!", "quoted-short-pass!", "backtick-pass!", "curly-quoted-pass!", "curly-single-pass!"):
                    self.assertNotIn(value, json.dumps(snapshot))
                    self.assertNotIn(value, stdout + stderr)
                projected = ["fatal: credential <v>: <v>"] if payload.startswith("credential ") else []
                self.assertEqual(snapshot, [*projected, "fatal: " + reason])
                self.assertEqual(receipt["output_tail"], snapshot)

    def test_real_home_child_redacts_short_known_secret_encodings(self) -> None:
        import base64
        from urllib.parse import quote

        for secret in ("fixture!", "~~~!", "tiny+/!"):
            raw = secret.encode("utf-8")
            forms = {
                secret,
                base64.b64encode(raw).decode("ascii"),
                base64.b64encode(raw).decode("ascii").rstrip("="),
                base64.urlsafe_b64encode(raw).decode("ascii"),
                base64.urlsafe_b64encode(raw).decode("ascii").rstrip("="),
                quote(secret, safe=""),
                quote(secret, safe="").lower(),
                "".join(f"%{byte:02x}" for byte in raw),
                "".join(f"%{byte:02X}" if index % 2 else f"%{byte:02x}" for index, byte in enumerate(raw)),
            }
            for encoded in forms:
                with self.subTest(secret=secret, encoded=encoded):
                    message = "credential decode failed: " + encoded
                    snapshot, receipt, stdout, stderr = self.home_exit([self.home_log(message)], secret)
                    for value in forms:
                        self.assertNotIn(value, json.dumps(snapshot))
                        self.assertNotIn(value, stdout + stderr)
                    self.assertEqual(snapshot, ["fatal: credential decode failed: <v>"])
                    self.assertEqual(receipt["output_tail"], snapshot)

    def test_home_error_tail_is_bounded_and_rejects_other_output(self) -> None:
        lines = [self.home_log(f"cluster coordinator error: connection refused {index}") for index in range(20)] + [
            "panic: unformatted output",
            self.home_log("ordinary informational message", "info "),
            self.home_log("é" * 700),
            self.home_log("x" * 8192 + "secret-in-oversized-line"),
            "-----BEGIN PRIVATE KEY-----",
            "private-key-body",
            "-----END PRIVATE KEY-----",
            self.home_log("database connection refused", "error"),
        ]
        snapshot, receipt, stdout, stderr = self.home_exit(lines)
        self.assertEqual(len(snapshot), 8)
        self.assertEqual(snapshot[-1], "error: database connection refused")
        self.assertEqual(receipt["output_tail"], snapshot)
        self.assertEqual(stdout, "")
        for value in ("unformatted output", "informational", "private-key-body", "secret-in-oversized-line"):
            self.assertNotIn(value, json.dumps(snapshot))
            self.assertNotIn(value, stderr)
        self.assertTrue(all(len(line.encode("utf-8")) <= 512 for line in snapshot))

    def test_real_home_child_bounds_whole_projected_tokens(self) -> None:
        message = "failed to start HTTPS server: " + "permission " * 100 + "/run/unknown-secret"
        snapshot, receipt, stdout, stderr = self.home_exit([self.home_log(message)])
        self.assertEqual(receipt["output_tail"], snapshot)
        self.assertEqual(len(snapshot), 1)
        self.assertLessEqual(len(snapshot[0].encode("utf-8")), 512)
        self.assertTrue(snapshot[0].endswith(" permission"))
        self.assertNotIn("unknown-secret", json.dumps(snapshot))
        self.assertNotIn("unknown-secret", stdout + stderr)

    def test_real_home_child_projects_unknown_colon_values_and_paths(self) -> None:
        cases = [
            ("failed to init runtime: access_token: short-pass!",
                "fatal: failed to init runtime: <v>: <v>"),
            ("failed to start HTTPS server: open /run/a!b: permission denied",
                "fatal: failed to start HTTPS server: open <v>: permission denied"),
        ]
        for stream in ("stdout", "stderr"):
            for message, expected in cases:
                with self.subTest(stream=stream, message=message):
                    snapshot, receipt, stdout, stderr = self.home_exit([self.home_log(message)], stream=stream)
                    self.assertEqual(snapshot, [expected])
                    self.assertEqual(receipt["output_tail"], snapshot)
                    for value in ("access_token", "short-pass!", "/run/a!b", "a!b"):
                        self.assertNotIn(value, json.dumps(snapshot))
                        self.assertNotIn(value, stdout + stderr)

    def test_real_home_child_projects_hex_base32_nested_and_split_encodings(self) -> None:
        import base64

        raw = b"fixture!"
        encoded = base64.b64encode(raw)
        unpadded = encoded.decode("ascii").rstrip("=")
        fragments = [unpadded[index:index + 4] for index in range(0, len(unpadded), 4)]
        forms = [
            raw.hex(),
            raw.hex().upper(),
            base64.b32encode(raw).decode("ascii").rstrip("="),
            base64.b64encode(encoded).decode("ascii"),
            base64.b64encode(encoded).decode("ascii").rstrip("="),
            " ".join(fragments),
        ]
        for value in forms:
            with self.subTest(value=value):
                snapshot, receipt, stdout, stderr = self.home_exit([
                    self.home_log("credential decode failed: " + value),
                ])
                self.assertEqual(snapshot, ["fatal: credential decode failed: <v>"])
                self.assertEqual(receipt["output_tail"], snapshot)
                for fragment in value.split():
                    self.assertNotIn(fragment, json.dumps(snapshot))
                    self.assertNotIn(fragment, stdout + stderr)
        for pieces in (["fix", "ture!"], fragments):
            with self.subTest(pieces=pieces):
                snapshot, receipt, stdout, stderr = self.home_exit([
                    self.home_log("credential decode failed: " + piece) for piece in pieces
                ])
                self.assertEqual(snapshot, ["fatal: credential decode failed: <v>"] * len(pieces))
                self.assertEqual(receipt["output_tail"], snapshot)
                for piece in pieces:
                    self.assertNotIn(piece, json.dumps(snapshot))
                    self.assertNotIn(piece, stdout + stderr)

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
            refresh_lease = getattr(ready, "refresh_policy_lease", None)
            if refresh_lease is not None and not refresh_lease("a" * 32):
                raise AssertionError("fixture could not establish the policy lease")

        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(supervisor, "ROOT", pathlib.Path(root)),
            patch.object(supervisor, "env_required", return_value=TOKEN_SENTINEL),
            patch.object(supervisor, "require_tmpfs"),
            patch.object(supervisor, "start_ready_server", side_effect=start_ready_server),
            patch.object(supervisor, "PolicyHealthMonitor", HealthyPolicyMonitor, create=True),
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

    def test_supervisor_names_the_child_that_exits_before_or_after_readiness(self) -> None:
        for phase, category in (("initial_health", 4), ("runtime", 5)):
            for name, exit_code in (("home", -9), ("node", 17)):
                with self.subTest(phase=phase, child=name):
                    stdout, stderr = io.StringIO(), io.StringIO()

                    def child(child_name: str, *args: Any) -> Any:
                        exits = iter([None, exit_code] if phase == "runtime" else [exit_code])
                        return SimpleNamespace(name=child_name, process=SimpleNamespace(
                            poll=lambda: next(exits) if child_name == name else None,
                        ))

                    class PolicyMonitor:
                        def __init__(self, *args: Any) -> None:
                            pass

                        def run(self, stop: Any) -> None:
                            pass

                    def ready_server(ready: readiness.Readiness) -> None:
                        self.assertTrue(ready.refresh_policy_lease("a" * 32))

                    with (
                        tempfile.TemporaryDirectory() as root,
                        patch.object(supervisor, "ROOT", pathlib.Path(root)),
                        patch.object(supervisor, "env_required", return_value=TOKEN_SENTINEL),
                        patch.object(supervisor, "require_tmpfs"),
                        patch.object(supervisor, "start_ready_server", side_effect=ready_server),
                        patch.object(supervisor, "PolicyHealthMonitor", PolicyMonitor),
                        patch.object(supervisor, "child_environment", return_value={}),
                        patch.object(supervisor, "Child", side_effect=child),
                        patch.object(supervisor, "wait_for_home", return_value="ready"),
                        patch.object(supervisor, "apply_pool_config"),
                        patch.object(supervisor, "create_node_jwt", return_value=("fixture-node", TOKEN_SENTINEL)),
                        patch.object(supervisor, "check_services", return_value=True),
                        patch.object(supervisor, "terminate_children"),
                        redirect_stdout(stdout),
                        redirect_stderr(stderr),
                    ):
                        self.assertEqual(supervisor.main(), 1)
                    lines = stderr.getvalue().splitlines()
                    marker, payload = lines[0].split(" ", 1)
                    self.assertEqual(marker, "POOL_CHILD_EXIT")
                    self.assertEqual(json.loads(payload), {"child": name, "exit_code": exit_code, "category": category})
                    self.assert_closed_output(stdout.getvalue(), "\n".join(lines[1:]), [category],
                        ["home_boot", "config_apply", "node_launch", "initial_health"])

    def test_child_exit_diagnostic_rejects_unbounded_names_and_statuses(self) -> None:
        from . import runtime_signals

        stderr = io.StringIO()
        with redirect_stderr(stderr):
            runtime_signals.report_child_exit(TOKEN_SENTINEL, 1, runtime_signals.FailureCategory.RUNTIME)
            runtime_signals.report_child_exit("home", True, runtime_signals.FailureCategory.RUNTIME)
            runtime_signals.report_child_exit("home", 256, runtime_signals.FailureCategory.RUNTIME)
            runtime_signals.report_child_exit("home", -256, runtime_signals.FailureCategory.RUNTIME)
        self.assertEqual(stderr.getvalue(), "")

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
