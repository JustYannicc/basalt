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
from unittest.mock import patch

from . import readiness, supervisor
from .pool_contract import StartupError


RESPONSE_SENTINEL = "private-response-sentinel"
TOKEN_SENTINEL = "private-token-sentinel"
CLASS_SENTINEL = "PrivateExceptionSentinel"


class OutputPrivacyTests(unittest.TestCase):
    def assert_closed_output(self, stdout: str, stderr: str, categories: list[int]) -> None:
        for value in (RESPONSE_SENTINEL, TOKEN_SENTINEL, CLASS_SENTINEL):
            self.assertNotIn(value, stdout + stderr)
        self.assertEqual(stdout, "")
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
        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(supervisor, "ROOT", pathlib.Path(root)),
            patch.object(supervisor, "env_required", return_value=TOKEN_SENTINEL),
            patch.object(supervisor, "require_tmpfs"),
            patch.object(supervisor, "start_ready_server", return_value=None),
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
        self.assert_closed_output(stdout.getvalue(), stderr.getvalue(), [5])

    def test_http_handler_failure_cannot_print_response_token_or_address(self) -> None:
        class ExplodingHandler(readiness.ReadyHandler):
            def _send(self, status: int, payload: dict[str, str]) -> None:
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
