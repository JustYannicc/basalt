"""Crash capture survives recovery drain failures without extending the deadline."""

from __future__ import annotations

import io
import json
import os
import pathlib
import sys
import threading
import unittest
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from unittest.mock import patch

from . import supervisor
from .pool_contract import StartupError
from .recovery_deadline import RecoveryDeadline, RecoveryTimeout, recovery_deadline


class CaptureRecoveryTests(unittest.TestCase):
    @contextmanager
    def exited_home(self):
        secret = "private-drain-failure-sentinel"
        record = (
            "[CLIProxyAPIHome] [2026-11-04 12:00:00] [--------] [fatal] "
            f"[main.go:123] failed to init runtime: connection refused {secret}"
        )
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            child = supervisor.Child(
                "home",
                [
                    sys.executable,
                    "-c",
                    f"print({record!r}, flush=True); raise SystemExit(1)",
                ],
                dict(os.environ),
                pathlib.Path.cwd(),
            )
            try:
                child.process.wait(timeout=5)
                child._reader.join(timeout=1)
                self.assertFalse(child._reader.is_alive())
                yield child, stderr
            finally:
                if child.process.stdout is not None:
                    child.process.stdout.close()
        self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())

    def assert_captured_receipt(self, child, stderr):
        lines = stderr.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        marker, payload = lines[0].split(" ", 1)
        self.assertEqual(marker, "POOL_CHILD_EXIT")
        expected = ["fatal: failed to init runtime: conn_refused"]
        self.assertEqual(child.diagnostics.snapshot(), expected)
        self.assertEqual(
            json.loads(payload),
            {"child": "home", "exit_code": 1, "category": 2, "output_tail": expected},
        )

    def test_startup_drain_failure_keeps_capture_and_original_exception(self):
        failure = StartupError("Home output reader did not finish")
        with self.exited_home() as (child, stderr):
            with (
                patch.object(supervisor, "drain_exited_home", side_effect=failure),
                self.assertRaises(StartupError) as raised,
            ):
                supervisor.wait_for_home(child, "fixture", threading.Event())
            self.assertIs(raised.exception, failure)
            self.assert_captured_receipt(child, stderr)

    def test_exhausted_episode_emits_capture_without_an_extra_reader_wait(self):
        with self.exited_home() as (child, stderr):
            deadline = RecoveryDeadline(threading.Event(), lambda: 180, started_at=0)
            with (
                recovery_deadline(deadline),
                patch.object(child._reader, "join", wraps=child._reader.join) as join,
                self.assertRaises(RecoveryTimeout),
            ):
                supervisor.wait_for_home(child, "fixture", threading.Event())
            join.assert_called_once_with(timeout=0.0)
            self.assert_captured_receipt(child, stderr)
