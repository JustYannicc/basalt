"""A selected runtime that cannot serve ends its container, and output never stalls Home."""

from __future__ import annotations

import http.client
import http.server
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack, redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from . import supervisor
from .db_distance import Distance
from .readiness import Readiness, ReadyHandler

try:
    from .output import Output
except ImportError:  # the image before this change has no output module
    Output = None
from .test_recovery import Clock, Stop

LAUNCH = {"POOL_LAUNCH_GENERATION": "7", "POOL_LAUNCH_TOKEN": "a" * 64}
RealChild = supervisor.Child  # the harness patches supervisor.Child while main runs
TICKS = 6


def fake_child(name: str, clock: Clock) -> supervisor.Child:
    """A real Child's methods over a scripted process and reader."""
    child = RealChild.__new__(RealChild)
    child.name = name
    child.diagnostics = None
    child.config_empty = threading.Event()
    child._processing_since = None
    child.exit_code = None
    child.reader_alive = True
    child.process = SimpleNamespace(
        poll=lambda: child.exit_code,
        wait=lambda timeout=None: child.exit_code,
        returncode=None,
        terminate=lambda: None,
        kill=lambda: None,
    )
    child._reader = SimpleNamespace(is_alive=lambda: child.reader_alive, join=lambda timeout=None: None)
    return child


class SelectedSupervisorTests(unittest.TestCase):
    def run_selected(self, on_tick, *, monitor_dies: bool = False, environment=LAUNCH):
        clock = Clock()
        stop = Stop(clock)
        launched: list[supervisor.Child] = []
        readiness: list[Readiness] = []
        release_monitor = threading.Event()
        self.addCleanup(release_monitor.set)
        ticks = [0]

        def make_child(name, *_args):
            child = fake_child(name, clock)
            launched.append(child)
            return child

        def ready_server(ready: Readiness) -> Mock:
            readiness.append(ready)
            ready.refresh_policy_lease("b" * 32)
            return Mock()

        class Monitor:
            def __init__(self, *_args) -> None:
                pass

            def run(self, _stop) -> None:
                if not monitor_dies:
                    release_monitor.wait()

        def on_wait(seconds: float) -> None:
            if seconds != 2:
                return
            ticks[0] += 1
            on_tick(ticks[0], launched, readiness[0], clock)
            if ticks[0] >= TICKS:
                stop.set()

        stop.on_wait = on_wait
        health = SimpleNamespace(check=lambda: True, invalidate=lambda: None)
        stderr = io.StringIO()
        with ExitStack() as stack:
            root = stack.enter_context(tempfile.TemporaryDirectory())
            for name, value in {
                "ROOT": pathlib.Path(root),
                "env_required": Mock(return_value="fixture"),
                "require_tmpfs": Mock(),
                "child_environment": Mock(return_value={}),
                "start_ready_server": ready_server,
                "Child": make_child,
                "wait_for_home": Mock(return_value="ready"),
                "apply_pool_config": Mock(),
                "create_node_jwt": Mock(return_value=("node", "jwt")),
                "check_services": Mock(return_value=True),
                "ServiceHealth": Mock(return_value=health),
                "DatabasePoolPoll": Mock(),
                "PolicyHealthMonitor": Monitor,
                "terminate_children": Mock(),
            }.items():
                stack.enter_context(patch.object(supervisor, name, value))
            stack.enter_context(
                patch.object(supervisor.db_distance, "measure_database", return_value=Distance("measured", 5, 6, 7))
            )
            stack.enter_context(patch.object(supervisor.time, "monotonic", clock))
            stack.enter_context(patch.object(supervisor.signal, "signal"))
            stack.enter_context(patch.dict(os.environ, environment))
            stack.enter_context(redirect_stdout(io.StringIO()))
            stack.enter_context(redirect_stderr(stderr))
            result = supervisor.main(stop)
        return result, launched, readiness[0], stderr.getvalue(), ticks[0]

    def assert_ended(self, outcome, reason: str) -> None:
        result, launched, ready, stderr, ticks = outcome
        self.assertEqual(result, 1, f"the container kept running after {ticks} ticks")
        self.assertLess(ticks, TICKS)
        self.assertEqual([child.name for child in launched].count("home"), 1, "Home was replaced in place")
        self.assertIn('POOL_SUPERVISOR_STOP {"reason":"' + reason + '"}', stderr)
        self.assertFalse(ready.snapshot()[0])
        self.assertEqual(ready.diagnostics(0)["stop_reason"], reason)

    def test_a_home_exit_ends_the_container_instead_of_a_replacement_in_place(self) -> None:
        def exit_home(tick, launched, _ready, _clock):
            if tick == 2:
                launched[0].exit_code = 1

        self.assert_ended(self.run_selected(exit_home), "child_exit")

    def test_a_fused_policy_plugin_ends_the_container(self) -> None:
        def fuse(tick, _launched, ready, _clock):
            if tick == 2:
                ready.note_policy_fused(ready.policy_observation_generation())

        self.assert_ended(self.run_selected(fuse), "policy_fused")

    def test_a_dead_policy_monitor_thread_ends_the_container(self) -> None:
        def wait_for_thread_end(tick, _launched, _ready, _clock):
            time.sleep(0.05)

        self.assert_ended(self.run_selected(wait_for_thread_end, monitor_dies=True), "monitor_dead")

    def test_a_dead_output_reader_ends_the_container(self) -> None:
        def kill_reader(tick, launched, _ready, _clock):
            if tick == 2:
                launched[0].reader_alive = False

        self.assert_ended(self.run_selected(kill_reader), "reader_dead")

    def test_a_blocked_output_reader_ends_the_container(self) -> None:
        def block_reader(tick, launched, _ready, clock):
            if tick == 2:
                launched[0]._processing_since = clock.now - supervisor.READER_STALL_SECONDS - 1

        self.assert_ended(self.run_selected(block_reader), "reader_blocked")

    def test_a_healthy_selected_runtime_keeps_serving(self) -> None:
        result, launched, ready, stderr, ticks = self.run_selected(lambda *_args: None)
        self.assertEqual((result, ticks), (0, TICKS))
        self.assertNotIn("POOL_SUPERVISOR_STOP", stderr)

    def test_the_legacy_launch_keeps_its_in_place_replacement(self) -> None:
        def exit_home(tick, launched, _ready, _clock):
            if tick == 2:
                launched[0].exit_code = 1
                launched[0].reader_alive = False

        result, launched, _ready, stderr, _ticks = self.run_selected(exit_home, environment={})
        self.assertEqual([child.name for child in launched].count("home"), 2)
        self.assertNotIn("POOL_SUPERVISOR_STOP", stderr)


class BlockingStream(io.TextIOBase):
    """A container stdout whose consumer has stopped reading."""

    def __init__(self) -> None:
        self.release = threading.Event()
        self.lines: list[str] = []

    def write(self, text: str) -> int:
        self.release.wait()
        self.lines.append(text)
        return len(text)

    def flush(self) -> None:
        pass


class OutputPipeTests(unittest.TestCase):
    def test_a_stalled_container_stdout_never_stalls_home(self) -> None:
        line = "[CLIProxyAPIHome] [2026-11-19 00:00:00] [--------] [warn ] SLOW SQL >= 200ms [300ms] [rows:1] SELECT 1"
        script = f"import sys\nfor _ in range(20000):\n    sys.stdout.write({line!r} + '\\n')\n"
        stream = BlockingStream()
        self.addCleanup(stream.release.set)
        output = Output(out=stream, err=stream) if Output is not None else None
        with ExitStack() as stack:
            root = stack.enter_context(tempfile.TemporaryDirectory())
            stack.enter_context(patch.object(sys, "stdout", stream))
            if output is not None:
                stack.enter_context(patch.object(supervisor, "emit", output.emit))
            child = supervisor.Child("home", [sys.executable, "-c", script], {}, pathlib.Path(root))
            try:
                # Two megabytes through a 64 KiB pipe: Home only finishes if its output keeps draining.
                finished = child.process.wait(timeout=20) == 0
            except subprocess.TimeoutExpired:
                child.process.kill()
                finished = False
            finally:
                stream.release.set()
                child._reader.join(timeout=10)
                child.process.stdout.close()
        self.assertTrue(finished, "Home blocked on a full output pipe")
        output.drain(10)
        self.assertGreater(output.dropped_total(), 0)
        self.assertTrue(any(text.startswith("POOL_OUTPUT_DROPPED ") for text in stream.lines))


class DiagnosticsTests(unittest.TestCase):
    def test_diagnostics_need_the_bearer_and_return_closed_state(self) -> None:
        ready = Readiness("fixture", launch_generation="7", launch_token="a" * 64)
        ready.set_diagnostics(lambda after: {"boot_id": ready.boot_id, "after": after})
        handler = type("Handler", (ReadyHandler,), {"readiness": ready})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)

        def get(path: str, key: str = "fixture") -> tuple[int, dict]:
            client = http.client.HTTPConnection(*server.server_address, timeout=2)
            client.request("GET", path, headers={"Authorization": f"Bearer {key}"})
            response = client.getresponse()
            body = json.loads(response.read())
            client.close()
            return response.status, body

        self.assertEqual(get("/diagnostics"), (200, {"boot_id": ready.boot_id, "after": 0}))
        self.assertEqual(get("/diagnostics?after=42")[1]["after"], 42)
        self.assertEqual(get("/diagnostics", "wrong")[0], 401)
        self.assertEqual(get("/diagnostics?after=-1")[0], 400)

    def test_the_supervisor_view_lists_children_tail_and_new_signals(self) -> None:
        clock = Clock()
        ready = Readiness("fixture")
        home, node = fake_child("home", clock), fake_child("node", clock)
        node.exit_code = 9
        before = supervisor.OUTPUT.lines_after(0)[-1][0] if supervisor.OUTPUT.lines_after(0) else 0
        with redirect_stdout(io.StringIO()):
            supervisor.emit('POOL_DB_DISTANCE {"state":"measured"}')
        view = supervisor.diagnostics(ready, [home, node], {"reason": "child_exit"}, before)
        self.assertEqual(view["children"], [
            {"name": "home", "state": "running"},
            {"name": "node", "state": "exited", "exit_code": 9},
        ])
        self.assertEqual(view["stop_reason"], "child_exit")
        self.assertEqual([entry["line"] for entry in view["signals"]], ['POOL_DB_DISTANCE {"state":"measured"}'])
        self.assertEqual(view["crash_tail"], [])


if __name__ == "__main__":
    unittest.main()
