"""Exercise the production monitor and readiness handler against a loaded Home plugin host."""

from __future__ import annotations

import http.client
import json
import os
import pathlib
import platform
import select
import socket
import subprocess
import threading
import time
import unittest
from typing import Any
from unittest.mock import patch

try:
    from . import child_signals, policy_monitor, pool_contract, readiness, supervisor
    from .test_native_policy_observation import run_monitor_until_policy_lease
    from .policy_monitor import PolicyHealthMonitor
except ImportError:
    from pool import child_signals, policy_monitor, pool_contract, readiness, supervisor
    from test_native_policy_observation import run_monitor_until_policy_lease
    from pool.policy_monitor import PolicyHealthMonitor

MANAGEMENT_KEY = "native-policy-integration-management-key"
SIGNING_KEY = "1" * 64
HOME_PORT = 8327
READY_MARKER = "POOL_NATIVE_POLICY_TEST_HOME_READY"


def helper_request(path: str, method: str = "POST") -> dict[str, Any]:
    connection = http.client.HTTPConnection("127.0.0.1", HOME_PORT, timeout=2)
    connection.request(method, path)
    response = connection.getresponse()
    raw = response.read()
    connection.close()
    if response.status not in (200, 202, 204):
        raise AssertionError(f"test Home helper {path} returned {response.status}: {raw!r}")
    return json.loads(raw) if raw else {}


def ready_request(host: str, port: int) -> tuple[int, dict[str, str], str | None]:
    connection = http.client.HTTPConnection(host, port, timeout=1)
    connection.request(
        "GET",
        "/ready",
        headers={"Authorization": f"Bearer {MANAGEMENT_KEY}"},
    )
    response = connection.getresponse()
    raw = response.read()
    lease = response.getheader("X-Signalbox-Policy-Lease-Ms")
    connection.close()
    return response.status, json.loads(raw), lease


def percentile(samples: list[int], percent: int) -> int:
    ordered = sorted(samples)
    index = max(0, min(len(ordered) - 1, (len(ordered) * percent + 99) // 100 - 1))
    return ordered[index]


class NativePolicyProductionIntegrationTests(unittest.TestCase):
    def test_loaded_host_loss_fuse_recovery_and_whole_probe_cost(self) -> None:
        helper_path = os.environ.get("POOL_NATIVE_POLICY_TEST_HOST")
        plugin_dir = os.environ.get("POOL_NATIVE_POLICY_TEST_PLUGIN_DIR")
        if not helper_path or not plugin_dir:
            self.fail("Docker runtime proof host/plugin paths were not supplied")
        self.assertTrue(pathlib.Path(helper_path).is_file())
        self.assertTrue(pathlib.Path(plugin_dir, "basalt-native-policy.so").is_file())
        if pool_contract.NATIVE_POLICY_SOCKET.exists():
            self.fail(f"test native policy socket already exists: {pool_contract.NATIVE_POLICY_SOCKET}")

        with socket.socket() as reservation:
            try:
                reservation.bind(("127.0.0.1", HOME_PORT))
            except OSError as error:
                self.fail(f"test Home port {HOME_PORT} is already in use: {error}")

        ready = readiness.Readiness(MANAGEMENT_KEY)
        ready_handler = type("IntegrationReadyHandler", (readiness.ReadyHandler,), {"readiness": ready})
        ready_server = readiness.ReadyServer(("127.0.0.1", 0), ready_handler)
        ready_server.daemon_threads = True
        ready_thread = threading.Thread(target=ready_server.serve_forever, daemon=True)
        ready_thread.start()
        ready_host, ready_port = ready_server.server_address

        child_env = pool_contract.child_environment("home", MANAGEMENT_KEY)
        child_env.update(
            {
                "POOL_APP_SIGNING_KEY": SIGNING_KEY,
                "POOL_APP_SIGNING_KEY_PREVIOUS": "",
                "POOL_NATIVE_POLICY_TEST_PLUGIN_DIR": plugin_dir,
                "POOL_NATIVE_POLICY_TEST_HOME_PORT": str(HOME_PORT),
                "POOL_NATIVE_POLICY_SOCKET": str(pool_contract.NATIVE_POLICY_SOCKET),
            }
        )
        process = subprocess.Popen(
            [helper_path],
            cwd=str(pool_contract.ROOT),
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        child: supervisor.Child | None = None
        child_reader: threading.Thread | None = None
        print_patcher = None
        captured_stdout: list[str] = []
        capture_lock = threading.Lock()

        try:
            if process.stdout is None:
                self.fail("test Home helper did not expose stdout")
            readable, _, _ = select.select([process.stdout], [], [], 5)
            if not readable:
                self.fail("test Home helper did not reach its ready event")
            startup = process.stdout.readline().strip()
            if startup != READY_MARKER:
                self.fail(f"test Home helper failed before ready: {startup!r}")
            plugin_state = helper_request("/v8/management/plugins", method="GET")
            self.assertIs(plugin_state.get("plugins_enabled"), True)
            self.assertTrue(
                any(
                    isinstance(plugin, dict)
                    and plugin.get("id") == readiness.POLICY_PLUGIN_ID
                    and plugin.get("effective_enabled") is True
                    for plugin in plugin_state.get("plugins", [])
                )
            )
            ready.set_ready(True)

            def capture_print(*args: object, **_kwargs: object) -> None:
                with capture_lock:
                    captured_stdout.append(" ".join(str(value) for value in args))

            print_patcher = patch.object(
                supervisor, "print", side_effect=capture_print, create=True
            )
            print_patcher.start()
            child = object.__new__(supervisor.Child)
            child.name = "home"
            child._on_policy_fused = ready.note_policy_fused
            child._on_policy_probe = ready.note_policy_probe
            child._fuse_parser = child_signals.NativePolicyFuseParser()
            child._policy_probe_parser = child_signals.NativePolicyProbeParser()
            child.config_empty = threading.Event()
            child.process = process
            child_reader = threading.Thread(target=child._read_output, daemon=True)
            child_reader.start()

            with patch.object(policy_monitor, "HOME_URL", f"http://127.0.0.1:{HOME_PORT}"):
                monitor = PolicyHealthMonitor(ready, MANAGEMENT_KEY)
                status, payload, lease = ready_request(ready_host, ready_port)
                self.assertEqual(status, 503, "readiness must fail closed before the first policy lease")
                self.assertEqual(set(payload), {"boot_id", "started_at"})
                self.assertIsNone(lease)

                lease_acquired, startup_states = run_monitor_until_policy_lease(
                    monitor, ready, timeout_seconds=5
                )
                self.assertTrue(
                    lease_acquired,
                    f"production monitor did not acquire a lease; probe states={startup_states}",
                )
                self.assertIn("healthy", startup_states)
                print(f"native-policy production startup probe states={startup_states}")
                status, payload, lease = ready_request(ready_host, ready_port)
                self.assertEqual(status, 200)
                self.assertEqual(set(payload), {"boot_id", "started_at"})
                self.assertIsNotNone(lease)
                self.assertGreater(int(lease or "0"), 0)

                helper_request("/native-policy-test/load/start")
                monitor_wall: list[int] = []
                monitor_cpu: list[int] = []
                for _ in range(16):
                    cpu_started = time.process_time_ns()
                    wall_started = time.perf_counter_ns()
                    self.assertEqual(monitor.check_once(), "healthy")
                    monitor_wall.append(time.perf_counter_ns() - wall_started)
                    monitor_cpu.append(time.process_time_ns() - cpu_started)
                load_result = helper_request("/native-policy-test/load/stop")
                self.assertGreater(int(load_result.get("picks", 0)), 0)

                callback_wall: list[int] = []
                callback_cpu: list[int] = []
                for index in range(8):
                    nonce = f"integration_{index}_" + "p" * 24
                    wall_started = time.perf_counter_ns()
                    status, probe = pool_contract.native_policy_request(
                        "/probe", {"nonce": nonce}, timeout=0.25
                    )
                    callback_wall.append(time.perf_counter_ns() - wall_started)
                    cpu_ns = probe.get("cpu_ns")
                    self.assertEqual(status, 200)
                    self.assertIs(type(cpu_ns), int, f"callback CPU sample missing: {probe!r}")
                    callback_cpu.append(cpu_ns)
                    self.assertTrue(ready.wait_for_policy_probe(nonce, 0.25))

                self.assertLess(max(monitor_wall), 250_000_000)
                self.assertLess(max(callback_wall), 250_000_000)
                print(
                    "native-policy whole monitor under 4-worker Home load: "
                    f"samples={len(monitor_wall)} wall_p50_ms={percentile(monitor_wall, 50) / 1e6:.3f} "
                    f"wall_p95_ms={percentile(monitor_wall, 95) / 1e6:.3f} "
                    f"python_cpu_p50_ms={percentile(monitor_cpu, 50) / 1e6:.3f} "
                    f"python_cpu_p95_ms={percentile(monitor_cpu, 95) / 1e6:.3f}"
                )
                print(
                    "native-policy callback under 4-worker Home load: "
                    f"samples={len(callback_wall)} wall_p50_ms={percentile(callback_wall, 50) / 1e6:.3f} "
                    f"wall_p95_ms={percentile(callback_wall, 95) / 1e6:.3f} "
                    f"callback_cpu_p50_ms={percentile(callback_cpu, 50) / 1e6:.3f} "
                    f"callback_cpu_p95_ms={percentile(callback_cpu, 95) / 1e6:.3f}"
                )

                helper_request("/native-policy-test/fuse")
                self.assertEqual(monitor.check_once(), "unavailable")
                status, payload, lease = ready_request(ready_host, ready_port)
                self.assertEqual(status, 503)
                self.assertIsNone(lease)
                self.assertEqual(set(payload), {"boot_id", "started_at"})
                self.assertEqual(monitor.check_once(), "unavailable")

                helper_request("/native-policy-test/disable")
                self.assertEqual(monitor.check_once(), "unavailable")
                self.assertEqual(ready_request(ready_host, ready_port)[0], 503)

                helper_request("/native-policy-test/enable")
                self.assertEqual(monitor.check_once(), "healthy")
                status, payload, lease = ready_request(ready_host, ready_port)
                self.assertEqual(status, 200)
                self.assertIsNotNone(lease)
                self.assertGreater(int(lease or "0"), 0)

            with capture_lock:
                captured = "\n".join(captured_stdout)
            self.assertIn(child_signals.NATIVE_POLICY_FUSED_MARKER + '{"count":1}', captured)
            self.assertNotIn("private-panic-sentinel", captured)
            self.assertNotIn(child_signals.NATIVE_POLICY_PROBE_LOG_PREFIX, captured)
            print(f"native-policy integration platform={platform.system()}/{platform.machine()} instance_recovery=pass")
        finally:
            try:
                helper_request("/native-policy-test/load/stop")
            except (OSError, AssertionError):
                pass
            try:
                helper_request("/native-policy-test/shutdown")
            except (OSError, AssertionError):
                pass
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if child_reader is not None:
                child_reader.join(timeout=1)
            if process.stdout is not None:
                process.stdout.close()
            if print_patcher is not None:
                print_patcher.stop()
            ready_server.shutdown()
            ready_server.server_close()
            ready_thread.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
