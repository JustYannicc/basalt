"""Keep dispatch timings visible without exposing request or failure text."""

import io
import json
import pathlib
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout

from .child_signals import safe_child_output_line
from .supervisor import Child


class DispatchSignalTests(unittest.TestCase):
    @staticmethod
    def formatted(name, message):
        prefix = "[CLIProxyAPIHome] " if name == "home" else ""
        return prefix + "[2026-11-11 19:00:00] [--------] [info ] [dispatch.go:123] " + message

    def test_real_child_forwards_only_closed_timings_from_both_streams(self):
        for name, stage in (("home", "admission"), ("node", "rpop")):
            for stream in ("stdout", "stderr"):
                with self.subTest(name=name, stream=stream):
                    message = f'POOL_{name.upper()}_DISPATCH_TIMING ' + json.dumps(
                        {"stage": stage, "duration_ms": 3001, "outcome": "timeout"})
                    good = self.formatted(name, message)
                    bad = self.formatted(name, message[:-1] + ',"error":"private-error-sentinel"}')
                    program = f"import sys;print({bad!r},file=sys.{stream},flush=True);print({good!r},file=sys.{stream},flush=True)"
                    stdout, stderr = io.StringIO(), io.StringIO()
                    with redirect_stdout(stdout), redirect_stderr(stderr):
                        child = Child(name, [sys.executable, "-c", program], {}, pathlib.Path.cwd())
                        try:
                            self.assertEqual(child.process.wait(timeout=5), 0)
                            child._reader.join(timeout=1)
                            self.assertFalse(child._reader.is_alive())
                        finally:
                            if child.process.stdout is not None:
                                child.process.stdout.close()
                    lines = stdout.getvalue().splitlines()
                    self.assertEqual(len(lines), 1)
                    marker, payload = lines[0].split(" ", 1)
                    self.assertEqual(marker, f"POOL_{name.upper()}_DISPATCH_TIMING")
                    self.assertEqual(json.loads(payload), {"stage": stage, "duration_ms": 3001, "outcome": "timeout"})
                    self.assertNotIn("private-", stdout.getvalue() + stderr.getvalue())

    def test_schema_is_closed_and_bounded(self):
        for name, stages in (("home", ("authenticate", "selection", "admission", "reply_write")), ("node", ("ping", "rpop"))):
            for stage in stages:
                for outcome in ("ok", "error", "timeout", "cancelled"):
                    for duration in (0, 86400000):
                        event = {"stage": stage, "duration_ms": duration, "outcome": outcome}
                        message = f"POOL_{name.upper()}_DISPATCH_TIMING " + json.dumps(event)
                        self.assertIsNotNone(safe_child_output_line(name, message))
                        self.assertIsNotNone(safe_child_output_line(name, self.formatted(name, message)))
            base = {"stage": stages[0], "duration_ms": 1, "outcome": "ok"}
            for field, values in (("stage", ("private-model", [], None)), ("duration_ms", (-1, 86400001, True, 1.5, "1", None)), ("outcome", ("private-error", {}, None))):
                for value in values:
                    event = {**base, field: value}
                    self.assertIsNone(safe_child_output_line(name, f"POOL_{name.upper()}_DISPATCH_TIMING " + json.dumps(event)))
            marker = f"POOL_{name.upper()}_DISPATCH_TIMING "
            for value in (
                '{"stage":"ping","stage":"rpop","duration_ms":1,"outcome":"ok"}',
                json.dumps({**base, "request": "private-request"}),
                json.dumps(base) + " private-error",
                json.dumps(base) + "\nprivate-error",
                json.dumps(base) + "\rprivate-error",
                "[]", "null",
            ):
                self.assertIsNone(safe_child_output_line(name, marker + value))
            self.assertIsNone(safe_child_output_line("unrelated", marker + json.dumps(base)))
            other = "node" if name == "home" else "home"
            self.assertIsNone(safe_child_output_line(other, marker + json.dumps(base)))
