"""A failed usage write remains visible without forwarding database error text."""

import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

from .child_signals import safe_child_output_line
from .runtime_signals import FailureCategory
from .supervisor import Child, report_exit


class UsageWriteSignalTests(unittest.TestCase):
    def test_live_failure_and_crash_tail_survive_both_child_streams(self):
        secret = "private-usage-error-sentinel"
        for stream in ("stdout", "stderr"):
            for kind, template in (
                ("async", "usage database async write error"),
                ("sync", "usage database write error"),
            ):
                with self.subTest(stream=stream, kind=kind):
                    line = (
                        "[CLIProxyAPIHome] [2026-11-09 08:00:00] [--------] [error] "
                        f"[usage_queue.go:164] {template}: SQLSTATE 42501 {secret}"
                    )
                    later = 'POOL_PRIVACY_PROGRESS {"batches":1,"rows_updated":2}'
                    program = (
                        f"import sys; print({line!r},file=sys.{stream},flush=True); "
                        f"print({later!r},flush=True); raise SystemExit(1)"
                    )
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        child = Child("home", [sys.executable, "-c", program], {}, pathlib.Path.cwd())
                        try:
                            child.process.wait(timeout=5)
                            child._reader.join(timeout=1)
                            self.assertFalse(child._reader.is_alive())
                            report_exit(child, 1, FailureCategory.RUNTIME)
                        finally:
                            if child.process.stdout is not None:
                                child.process.stdout.close()
                    lines = stdout.getvalue().splitlines()
                    marker, payload = lines[0].split(" ", 1)
                    self.assertEqual(marker, "POOL_USAGE_WRITE_FAILURE")
                    self.assertEqual(json.loads(payload), {"async": int(kind == "async"), "sync": int(kind == "sync")})
                    self.assertEqual(lines[1], later, "a failed write must not stop signal capture")
                    receipt = json.loads(stderr.getvalue().split(" ", 1)[1])
                    self.assertEqual(receipt["output_tail"], [f"error: {template}: sql"])
                    self.assertNotIn(secret, stdout.getvalue() + stderr.getvalue())
                    self.assertNotIn("42501", stdout.getvalue() + stderr.getvalue())

    def test_json_and_unrelated_output_keep_the_closed_projection(self):
        line = json.dumps({"level": "error", "msg": "usage database async write error: private"})
        self.assertEqual(safe_child_output_line("home", line), 'POOL_USAGE_WRITE_FAILURE {"async":1,"sync":0}')
        self.assertIsNone(safe_child_output_line("node", line))
        self.assertIsNone(safe_child_output_line("home", "unrelated provider error: private"))
        self.assertIsNone(safe_child_output_line("home", "usage database async write error-ish: private"))
