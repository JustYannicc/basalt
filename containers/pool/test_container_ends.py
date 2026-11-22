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
    child.reaped = True
    child.reader_alive = True

    def wait(timeout=None):
        if child.exit_code is None:
            raise subprocess.TimeoutExpired(name, timeout)
        child.reaped = True
        return child.exit_code

    child.process = SimpleNamespace(
        poll=lambda: child.exit_code if child.reaped else None,
        wait=wait,
        returncode=None,
        terminate=lambda: None,
        kill=lambda: None,
    )
    child._reader = SimpleNamespace(is_alive=lambda: child.reader_alive, join=lambda timeout=None: None)
    return child


class SelectedSupervisorTests(unittest.TestCase):
    def run_selected(
        self,
        on_tick,
        *,
        monitor_dies: bool = False,
        environment=LAUNCH,
        on_startup_wait=None,
        services=True,
        boot=None,
        prepare=None,
    ):
        clock = Clock()
        stop = Stop(clock)
        launched: list[supervisor.Child] = []
        readiness: list[Readiness] = []
        servers: list[Mock] = []
        release_monitor = threading.Event()
        self.addCleanup(release_monitor.set)
        ticks = [0]
        self.monitor_threads: list[threading.Thread] = []
        self.at_stop: dict[str, object] = {}

        def make_child(name, *_args):
            child = fake_child(name, clock)
            launched.append(child)
            return child

        def ready_server(ready: Readiness) -> Mock:
            readiness.append(ready)
            ready.refresh_policy_lease("b" * 32)
            if prepare is not None:
                prepare(ready, stop)
            servers.append(Mock())
            return servers[-1]

        class Monitor:
            def __init__(self, *_args) -> None:
                pass

            def run(self, _stop) -> None:
                test.monitor_threads.append(threading.current_thread())
                if not monitor_dies:
                    release_monitor.wait()

        test = self

        def on_wait(seconds: float) -> None:
            if seconds != 2:
                if on_startup_wait is not None:
                    on_startup_wait(launched, readiness[0])
                return
            ticks[0] += 1
            on_tick(ticks[0], launched, readiness[0], clock)
            if ticks[0] >= TICKS:
                stop.set()

        def at_terminate(_children) -> None:
            # What the controller can still read while Home gets its stop grace.
            if readiness and "ready" not in self.at_stop:
                self.at_stop["ready"] = readiness[0].snapshot()[0]
                self.at_stop["diagnostics"] = readiness[0].diagnostics(0)
                self.at_stop["server_shut"] = servers[-1].shutdown.called

        stop.on_wait = on_wait
        health = SimpleNamespace(check=lambda: True, invalidate=lambda: None)
        self.service_health = Mock(return_value=health)
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
                "wait_for_home": boot or Mock(return_value="ready"),
                "apply_pool_config": Mock(),
                "create_node_jwt": Mock(return_value=("node", "jwt")),
                "check_services": Mock(return_value=services),
                "ServiceHealth": self.service_health,
                "home_database_distance": Mock(return_value=5),
                "PolicyHealthMonitor": Monitor,
                "terminate_children": Mock(side_effect=at_terminate),
            }.items():
                stack.enter_context(patch.object(supervisor, name, value))
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
        self.assertIs(self.at_stop["ready"], False)
        self.assertEqual(self.at_stop["diagnostics"]["stop_reason"], reason)
        self.assertFalse(self.at_stop["server_shut"], "/diagnostics closed before the children stopped")

    def test_a_home_exit_ends_the_container_instead_of_a_replacement_in_place(self) -> None:
        def exit_home(tick, launched, _ready, _clock):
            if tick == 2:
                launched[0].exit_code = 1
                launched[0].reader_alive = False

        self.assert_ended(self.run_selected(exit_home), "child_exit")

    def test_a_fused_policy_plugin_ends_the_container(self) -> None:
        def fuse(tick, _launched, ready, _clock):
            if tick == 2:
                ready.note_policy_fused(ready.policy_observation_generation())

        self.assert_ended(self.run_selected(fuse), "policy_fused")

    def test_a_dead_policy_monitor_thread_ends_the_container(self) -> None:
        def wait_for_thread_end(tick, _launched, _ready, _clock):
            for thread in self.monitor_threads:
                thread.join(5)

        self.assert_ended(self.run_selected(wait_for_thread_end, monitor_dies=True), "monitor_dead")

    def test_a_dead_output_reader_ends_the_container(self) -> None:
        def kill_reader(tick, launched, _ready, _clock):
            if tick == 2:
                launched[0].reader_alive = False

        drained: list[str] = []
        with patch.object(RealChild, "discard_output", lambda child: drained.append(child.name)):
            self.assert_ended(self.run_selected(kill_reader), "reader_dead")
        self.assertEqual(drained, ["home"], "the stopping Home's undrained pipe must keep draining")

    def test_a_dead_node_reader_ends_the_container(self) -> None:
        def kill_reader(tick, launched, _ready, _clock):
            if tick == 2:
                next(child for child in launched if child.name == "node").reader_alive = False

        self.assert_ended(self.run_selected(kill_reader), "reader_dead")

    def test_a_reader_that_ends_with_its_child_reports_the_exit(self) -> None:
        def exit_node(tick, launched, _ready, _clock):
            if tick == 2:
                node = next(child for child in launched if child.name == "node")
                node.reader_alive = False
                node.reaped = False  # the pipe closed before the exit could be reaped
                node.exit_code = 1

        outcome = self.run_selected(exit_node)
        self.assertIn('POOL_SUPERVISOR_STOP {"reason":"child_exit"}', outcome[3])

    def test_a_fuse_during_initial_health_ends_the_container_at_once(self) -> None:
        def fuse(_launched, ready):
            ready.note_policy_fused(ready.policy_observation_generation())

        result, _launched, _ready, stderr, ticks = self.run_selected(
            lambda *_args: None, on_startup_wait=fuse, services=False
        )
        self.assertEqual((result, ticks), (1, 0))
        self.assertIn('POOL_SUPERVISOR_STOP {"reason":"policy_fused"}', stderr)

    def test_a_blocked_output_reader_ends_the_container(self) -> None:
        def block_reader(tick, launched, _ready, clock):
            if tick == 2:
                launched[0]._processing_since = clock.now - getattr(supervisor, "READER_STALL_SECONDS", 10) - 1

        self.assert_ended(self.run_selected(block_reader), "reader_blocked")

    def test_a_healthy_selected_runtime_keeps_serving(self) -> None:
        result, launched, ready, stderr, ticks = self.run_selected(lambda *_args: None)
        self.assertEqual((result, ticks), (0, TICKS))
        self.assertNotIn("POOL_SUPERVISOR_STOP", stderr)
        # The liveness check is what puts Home's refresh count on /ready.
        self.assertEqual(self.service_health.call_args.kwargs.get("observe"), ready.note_refresh_in_flight)

    def test_a_home_exit_during_boot_ends_the_container(self) -> None:
        boot = Mock(side_effect=supervisor.HomeExited(1))
        self.assert_ended(self.run_selected(lambda *_args: None, boot=boot), "child_exit")

    def test_a_child_exit_during_initial_health_ends_the_container(self) -> None:
        def exit_node(launched, _ready):
            next(child for child in launched if child.name == "node").exit_code = 1

        self.assert_ended(
            self.run_selected(lambda *_args: None, on_startup_wait=exit_node, services=False), "child_exit"
        )

    def test_a_stop_that_ends_the_monitor_is_not_reported_as_its_death(self) -> None:
        def sigterm_during_the_check(ready, stop):
            # SIGTERM lands between the loop's stop check and the serving check.
            ready.policy_fused = lambda: (stop.set(), False)[1]

        result, _launched, _ready, stderr, _ticks = self.run_selected(
            lambda *_args: None, monitor_dies=True, services=False, prepare=sigterm_during_the_check
        )
        self.assertEqual(result, 0)
        self.assertNotIn("POOL_SUPERVISOR_STOP", stderr)

    def test_the_legacy_launch_keeps_its_in_place_replacement(self) -> None:
        def exit_home(tick, launched, _ready, _clock):
            if tick == 2:
                launched[0].exit_code = 1
                launched[0].reader_alive = False

        result, launched, _ready, stderr, _ticks = self.run_selected(exit_home, environment={})
        self.assertEqual([child.name for child in launched].count("home"), 2)
        self.assertNotIn("POOL_SUPERVISOR_STOP", stderr)


class ServingFailureTests(unittest.TestCase):
    def test_a_fuse_cleared_by_a_reloaded_instance_still_ends_the_container(self) -> None:
        ready = Readiness("fixture", monotonic_ns=lambda: 1)
        ready.enable_policy_observations()
        self.assertTrue(ready.refresh_policy_lease("a" * 32))
        ready.note_policy_fused(ready.policy_observation_generation())
        self.assertTrue(ready.refresh_policy_lease("b" * 32))
        self.assertFalse(ready.policy_fused())
        self.assertEqual(supervisor.serving_failure([], None, ready, 0), "policy_fused")

    def test_a_dead_reader_during_home_boot_ends_it_at_once(self) -> None:
        child = fake_child("home", Clock())
        stop = threading.Event()
        with patch.object(supervisor, "management_ready", return_value=False):
            with self.assertRaises(supervisor.ContainerEnding) as ending:
                supervisor.wait_for_home(child, "fixture", stop, lambda: "reader_dead")
        self.assertEqual(ending.exception.reason, "reader_dead")

    def test_a_real_reader_stuck_on_one_line_is_blocked(self) -> None:
        entered, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def stuck(_name, _line):
            entered.set()
            release.wait(10)

        with tempfile.TemporaryDirectory() as root, patch.object(supervisor, "safe_child_output_line", stuck):
            child = supervisor.Child("home", [sys.executable, "-c", "import time; print('one line', flush=True); time.sleep(30)"], {}, pathlib.Path(root))
            try:
                self.assertTrue(entered.wait(10), "the reader never reached the line")
                later = time.monotonic() + supervisor.READER_STALL_SECONDS + 1
                self.assertEqual(child.reader_failure(later), "reader_blocked")
                self.assertIsNone(child.reader_failure(time.monotonic()))
            finally:
                release.set()
                child.process.kill()
                child.process.wait(5)
                child._reader.join(5)
                child.process.stdout.close()


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
        # A line the supervisor forwards, so a stalled stdout fills the output queue.
        line = "[CLIProxyAPIHome] [2026-11-19 00:00:00] [--------] [error] usage derived-column backfill batch failed"
        script = f"import sys\nfor _ in range(20000):\n    sys.stdout.write({line!r} + '\\n')\n"
        stream = BlockingStream()
        self.addCleanup(stream.release.set)
        output = Output(out=stream, err=stream) if Output is not None else None
        if output is not None:
            self.addCleanup(output.close)
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


class SignalStream(io.StringIO):
    def __init__(self) -> None:
        super().__init__()
        self.written = threading.Event()

    def write(self, text: str) -> int:
        result = super().write(text)
        self.written.set()
        return result


class OutputLaneTests(unittest.TestCase):
    def output(self, out, err) -> Output:
        output = Output(out=out, err=err)
        self.addCleanup(output.close)
        stack = ExitStack()
        stack.enter_context(patch.object(sys, "stdout", out))
        stack.enter_context(patch.object(sys, "stderr", err))
        self.addCleanup(stack.close)
        return output

    def test_a_stalled_stdout_never_holds_back_the_stop_record(self) -> None:
        out, err = BlockingStream(), SignalStream()
        self.addCleanup(out.release.set)
        output = self.output(out, err)
        for index in range(5000):
            output.emit(f"line {index}")
        output.emit('POOL_SUPERVISOR_STOP {"reason":"child_exit"}', err=True)
        self.assertTrue(err.written.wait(5), "the stop record waited behind stdout")
        self.assertIn('POOL_SUPERVISOR_STOP {"reason":"child_exit"}', err.getvalue())

    def test_a_failing_write_does_not_end_the_writer(self) -> None:
        class Flaky(io.StringIO):
            failed = False

            def write(self, text: str) -> int:
                if not Flaky.failed:
                    Flaky.failed = True
                    raise RuntimeError("one bad write")
                return super().write(text)

        out = Flaky()
        output = self.output(out, io.StringIO())
        output.emit("first")
        output.emit("second")
        self.assertTrue(output.drain(5), "the writer stopped after one failed write")
        self.assertEqual(out.getvalue(), "second\n")


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
            supervisor.emit('POOL_HOME_MAINTENANCE_FAILURE {"cache_read":0,"derived_columns":1,"token_accounting":0}')
        view = supervisor.diagnostics(ready, [home, node], {"reason": "child_exit"}, before)
        self.assertEqual(view["children"], [
            {"name": "home", "state": "running"},
            {"name": "node", "state": "exited", "exit_code": 9},
        ])
        self.assertEqual(view["stop_reason"], "child_exit")
        self.assertEqual([entry["line"] for entry in view["signals"]], ['POOL_HOME_MAINTENANCE_FAILURE {"cache_read":0,"derived_columns":1,"token_accounting":0}'])
        self.assertEqual(view["crash_tail"], [])


if __name__ == "__main__":
    unittest.main()


class DiscardOutputTests(unittest.TestCase):
    def test_a_child_whose_reader_stopped_is_drained_so_it_can_finish(self) -> None:
        script = "import sys\nfor _ in range(20000):\n    sys.stdout.write('x' * 100 + '\\n')\n"
        with tempfile.TemporaryDirectory() as root, patch.object(RealChild, "_read_output", lambda _: None):
            child = RealChild("home", [sys.executable, "-c", script], {}, pathlib.Path(root))
            try:
                # Two megabytes into a 64 KiB pipe nobody reads: the child blocks on its next write.
                with self.assertRaises(subprocess.TimeoutExpired):
                    child.process.wait(timeout=1)
                child.discard_output()
                self.assertEqual(child.process.wait(timeout=20), 0)
            finally:
                if child.process.poll() is None:
                    child.process.kill()
                child.process.stdout.close()
