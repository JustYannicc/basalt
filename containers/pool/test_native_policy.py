"""Focused native policy readiness and sanitized control-plane tests."""

from __future__ import annotations

import http.client
import http.server
import json
import pathlib
import socket
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from typing import cast
from unittest.mock import patch

from . import child_signals, policy_monitor, pool_contract, readiness
from .policy_monitor import PolicyHealthMonitor, ProbeState


INSTANCE_A = "a" * 32
INSTANCE_B = "b" * 32
MANAGEMENT_KEY = "native-policy-management-key"


class FakeClock:
    def __init__(self) -> None:
        self.value = 1_000_000_000

    def now_ns(self) -> int:
        return self.value

    def advance(self, nanoseconds: int) -> None:
        self.value += nanoseconds


class NativePolicyReadinessTests(unittest.TestCase):
    def test_single_missed_refresh_keeps_readiness_until_monotonic_lease_expires(self) -> None:
        clock = FakeClock()
        status: list[tuple[ProbeState, str | None]] = [
                ("healthy", INSTANCE_A),
                ("missed", None),
        ]
        status_iter = iter(status)
        ready = readiness.Readiness(MANAGEMENT_KEY, clock.now_ns)
        ready.set_ready(True)
        monitor = PolicyHealthMonitor(ready, MANAGEMENT_KEY)
        with patch.object(policy_monitor, "probe_home_policy", side_effect=lambda *_: next(status_iter)):
            self.assertEqual(monitor.check_once(), "healthy")
            clock.advance(1_000_000_000)
            self.assertEqual(monitor.check_once(), "missed")
            self.assertTrue(ready.snapshot()[0])

            clock.advance(500_000_000)
            self.assertFalse(ready.snapshot()[0])

    def test_policy_loop_keeps_the_lease_alive_through_a_quiet_minute(self) -> None:
        clock = FakeClock()
        ready = readiness.Readiness(MANAGEMENT_KEY, clock.now_ns)
        ready.set_ready(True)
        monitor = PolicyHealthMonitor(ready, MANAGEMENT_KEY)
        end = clock.value + 60_000_000_000
        lapses: list[int] = []

        def probe(*_: object) -> tuple[ProbeState, str | None]:
            # Every probe takes its whole budget.
            clock.advance(250_000_000)
            return "healthy", INSTANCE_A

        class QuietStop:
            def is_set(self) -> bool:
                return clock.value >= end

            def wait(self, seconds: float) -> bool:
                for _ in range(2):
                    if not ready.snapshot()[0]:
                        lapses.append(clock.value)
                    clock.advance(int(seconds * 500_000_000))
                return self.is_set()

        with (
            patch.object(policy_monitor, "probe_home_policy", side_effect=probe),
            patch.object(
                policy_monitor, "time", SimpleNamespace(monotonic=lambda: clock.value / 1e9)
            ),
        ):
            monitor.run(cast(threading.Event, QuietStop()))
        self.assertEqual(lapses, [])
        self.assertTrue(ready.snapshot()[0])

    def test_plugin_unload_loses_readiness_and_restored_instance_recovers(self) -> None:
        clock = FakeClock()
        status: list[tuple[ProbeState, str | None]] = [
                ("healthy", INSTANCE_A),
                ("unavailable", None),
                ("healthy", INSTANCE_B),
        ]
        status_iter = iter(status)
        ready = readiness.Readiness(MANAGEMENT_KEY, clock.now_ns)
        ready.set_ready(True)
        monitor = PolicyHealthMonitor(ready, MANAGEMENT_KEY)
        with patch.object(policy_monitor, "probe_home_policy", side_effect=lambda *_: next(status_iter)):
            self.assertEqual(monitor.check_once(), "healthy")
            self.assertTrue(ready.snapshot()[0])
            self.assertEqual(monitor.check_once(), "unavailable")
            self.assertFalse(ready.snapshot()[0])
            self.assertEqual(monitor.check_once(), "healthy")
            self.assertFalse(ready.snapshot()[0])
            ready.set_ready(True, audit_revision=ready.service_audit_revision())
            self.assertTrue(ready.snapshot()[0])

    def test_fuse_signal_latches_one_plugin_instance_until_reload(self) -> None:
        clock = FakeClock()
        ready = readiness.Readiness(MANAGEMENT_KEY, clock.now_ns)
        ready.set_ready(True)
        self.assertTrue(ready.refresh_policy_lease(INSTANCE_A))
        parser = child_signals.NativePolicyFuseParser()
        lines = [
            "[CLIProxyAPIHome] [2026-10-31 10:00:00] [--------] [error] [adapters_usage_translation.go:104] "
            "pluginhost: plugin panic recovered: private-panic-sentinel\n",
            "goroutine 27 [running]:\n",
            "plugin_id=basalt-native-policy\n",
        ]
        signal = None
        for line in lines:
            signal = parser.feed("home", line) or signal
        self.assertEqual(
            signal,
            child_signals.NATIVE_POLICY_FUSED_MARKER + '{"count":1}',
        )
        self.assertNotIn("private-panic-sentinel", signal or "")

        ready.note_policy_fused()
        self.assertFalse(ready.snapshot()[0])
        self.assertFalse(ready.refresh_policy_lease(INSTANCE_A))
        self.assertFalse(ready.snapshot()[0])
        self.assertTrue(ready.refresh_policy_lease(INSTANCE_B))
        self.assertFalse(ready.snapshot()[0])
        ready.set_ready(True, audit_revision=ready.service_audit_revision())
        self.assertTrue(ready.snapshot()[0])

    def test_probe_heartbeat_parser_accepts_only_native_plugin_info_records(self) -> None:
        nonce = "n" * 32
        parser = child_signals.NativePolicyProbeParser()
        formatted = (
            "[CLIProxyAPIHome] [2026-10-31 10:00:00] [--------] [info ] "
            f"plugin_id=basalt-native-policy {child_signals.NATIVE_POLICY_PROBE_LOG_PREFIX}{nonce}\n"
        )
        self.assertEqual(parser.feed("home", formatted), nonce)
        self.assertIsNone(parser.feed("node", formatted))
        self.assertIsNone(
            parser.feed(
                "home",
                formatted.replace("plugin_id=basalt-native-policy", "plugin_id=other"),
            )
        )
        self.assertEqual(
            parser.feed(
                "home",
                json.dumps(
                    {
                        "level": "info",
                        "msg": child_signals.NATIVE_POLICY_PROBE_LOG_PREFIX + nonce,
                        "plugin_id": "basalt-native-policy",
                    }
                ),
            ),
            nonce,
        )

    def test_home_probe_requires_active_plugin_and_same_instance_callback(self) -> None:
        nonce = "n" * 32
        plugin_payload = {
            "plugins_enabled": True,
            "plugins": [
                {
                    "id": policy_monitor.POLICY_PLUGIN_ID,
                    "registered": True,
                    "enabled": True,
                    "effective_enabled": True,
                }
            ],
        }
        callback_payload = {"ok": True, "nonce": nonce, "instance": INSTANCE_A}
        with (
            patch.object(policy_monitor.secrets, "token_urlsafe", return_value=nonce),
            patch.object(policy_monitor, "request_json", return_value=(200, plugin_payload)) as home,
            patch.object(policy_monitor, "native_policy_request", return_value=(200, callback_payload)) as probe,
        ):
            ready = readiness.Readiness(MANAGEMENT_KEY)
            with patch.object(ready, "wait_for_policy_probe", return_value=True) as heartbeat:
                status, instance = policy_monitor.probe_home_policy(MANAGEMENT_KEY, ready)
        self.assertEqual((status, instance), ("healthy", INSTANCE_A))
        self.assertLessEqual(home.call_args.kwargs["timeout"], 0.25)
        self.assertLessEqual(probe.call_args.kwargs["timeout"], 0.25)
        self.assertEqual(probe.call_args.args, ("/probe", {"nonce": nonce}))
        self.assertEqual(heartbeat.call_args.args[0], nonce)
        self.assertLessEqual(heartbeat.call_args.args[1], 0.25)

        disabled_payload = {
            "plugins_enabled": True,
            "plugins": [
                {"id": policy_monitor.POLICY_PLUGIN_ID, "registered": False, "enabled": False, "effective_enabled": False}
            ],
        }
        with (
            patch.object(policy_monitor, "request_json", return_value=(200, disabled_payload)),
            patch.object(policy_monitor, "native_policy_request") as probe,
        ):
            self.assertEqual(
                policy_monitor.probe_home_policy(
                    MANAGEMENT_KEY, readiness.Readiness(MANAGEMENT_KEY)
                ),
                ("unavailable", None),
            )
            probe.assert_not_called()

    def test_probe_does_not_refresh_when_home_stdout_heartbeat_is_not_observed(self) -> None:
        nonce = "n" * 32
        plugin_payload = {
            "plugins_enabled": True,
            "plugins": [
                {
                    "id": policy_monitor.POLICY_PLUGIN_ID,
                    "registered": True,
                    "enabled": True,
                    "effective_enabled": True,
                }
            ],
        }
        ready = readiness.Readiness(MANAGEMENT_KEY)
        with (
            patch.object(policy_monitor.secrets, "token_urlsafe", return_value=nonce),
            patch.object(policy_monitor, "request_json", return_value=(200, plugin_payload)),
            patch.object(
                policy_monitor,
                "native_policy_request",
                return_value=(200, {"ok": True, "nonce": nonce, "instance": INSTANCE_A}),
            ),
            patch.object(ready, "wait_for_policy_probe", return_value=False) as heartbeat,
        ):
            self.assertEqual(
                policy_monitor.probe_home_policy(MANAGEMENT_KEY, ready),
                ("missed", None),
            )
        self.assertLessEqual(heartbeat.call_args.args[1], 0.25)

    def test_native_policy_install_route_returns_only_revision(self) -> None:
        ready = readiness.Readiness(MANAGEMENT_KEY)
        handler_type = type("TestReadyHandler", (readiness.ReadyHandler,), {"readiness": ready})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_type)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)

        with patch.object(
            readiness,
            "native_policy_request",
            return_value=(200, {"installed": True, "revision": 12, "accounts": ["must-not-escape"]}),
        ) as install:
            host, port = cast(tuple[str, int], server.server_address)
            connection = http.client.HTTPConnection(host, port, timeout=1)
            connection.request(
                "POST",
                "/native-policy",
                body=json.dumps({"projection": "sbm-policy1.payload.signature"}),
                headers={
                    "Authorization": f"Bearer {MANAGEMENT_KEY}",
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            body = response.read()
            connection.close()

        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {"installed": True, "revision": 12})
        self.assertNotIn("must-not-escape", body.decode())
        install.assert_called_once_with(
            "/install", {"projection": "sbm-policy1.payload.signature"}, timeout=1.0
        )

    def test_ready_http_reports_the_remaining_policy_lease_only_on_success(self) -> None:
        clock = FakeClock()
        ready = readiness.Readiness(MANAGEMENT_KEY, clock.now_ns)
        ready.set_ready(True)
        self.assertTrue(ready.refresh_policy_lease(INSTANCE_A))
        handler_type = type("TestReadyHandler", (readiness.ReadyHandler,), {"readiness": ready})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler_type)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)

        host, port = cast(tuple[str, int], server.server_address)
        connection = http.client.HTTPConnection(host, port, timeout=1)
        connection.request(
            "GET",
            "/ready",
            headers={"Authorization": f"Bearer {MANAGEMENT_KEY}"},
        )
        response = connection.getresponse()
        body = response.read()
        lease_ms = response.getheader("X-Signalbox-Policy-Lease-Ms")
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(lease_ms, "1500")
        # A ready answer records the flip that made it ready.
        self.assertEqual(set(json.loads(body)), {"boot_id", "started_at", "db_rtt_state", "flips", "last_flip"})

        clock.advance(1_234_000_000)
        connection = http.client.HTTPConnection(host, port, timeout=1)
        connection.request(
            "GET",
            "/ready",
            headers={"Authorization": f"Bearer {MANAGEMENT_KEY}"},
        )
        response = connection.getresponse()
        response.read()
        lease_ms = response.getheader("X-Signalbox-Policy-Lease-Ms")
        connection.close()
        self.assertEqual(response.status, 200)
        self.assertEqual(lease_ms, "266")

        clock.advance(266_000_000)
        connection = http.client.HTTPConnection(host, port, timeout=1)
        connection.request(
            "GET",
            "/ready",
            headers={"Authorization": f"Bearer {MANAGEMENT_KEY}"},
        )
        response = connection.getresponse()
        response.read()
        self.assertEqual(response.status, 503)
        self.assertIsNone(response.getheader("X-Signalbox-Policy-Lease-Ms"))
        connection.close()


class NativePolicyInstallBudgetTests(unittest.TestCase):
    """The plugin leg of an install gets 1 s, inside the controller's 2 s install budget."""

    def plugin(self, delay: float | None) -> None:
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = pathlib.Path(folder.name) / "native-policy.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        listener.listen(1)
        release = threading.Event()

        def serve() -> None:
            connection, _ = listener.accept()
            with connection:
                request = b""
                while b"\r\n\r\n" not in request:
                    request += connection.recv(4096)
                head, _, body = request.partition(b"\r\n\r\n")
                length = next(
                    int(line.split(b":", 1)[1])
                    for line in head.split(b"\r\n")
                    if line.lower().startswith(b"content-length:")
                )
                while len(body) < length:
                    body += connection.recv(4096)
                # A plugin that never answers holds the connection until the test ends.
                if delay is None or release.wait(delay):
                    release.wait()
                    return
                answer = json.dumps({"installed": True, "revision": 7}).encode()
                connection.sendall(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    + f"Content-Length: {len(answer)}\r\n\r\n".encode()
                    + answer
                )

        server = threading.Thread(target=serve, daemon=True)
        server.start()

        def stop() -> None:
            release.set()
            listener.close()
            server.join(timeout=2)

        self.addCleanup(stop)
        self.enterContext(patch.object(pool_contract, "NATIVE_POLICY_SOCKET", path))

    def install(self) -> tuple[int, dict[str, object], float]:
        """POST /native-policy as the controller does, with its 2 s install budget."""
        ready = readiness.Readiness(MANAGEMENT_KEY)
        handler = type("InstallBudgetHandler", (readiness.ReadyHandler,), {"readiness": ready})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)
        connection = http.client.HTTPConnection(*server.server_address, timeout=2)
        self.addCleanup(connection.close)
        started = time.monotonic()
        connection.request(
            "POST",
            "/native-policy",
            body=json.dumps({"projection": "sbm-policy1.fixture"}),
            headers={"Authorization": f"Bearer {MANAGEMENT_KEY}"},
        )
        response = connection.getresponse()
        payload = json.loads(response.read())
        return response.status, payload, time.monotonic() - started

    def test_a_plugin_answering_inside_its_second_installs(self) -> None:
        self.plugin(0.5)
        status, payload, _ = self.install()
        self.assertEqual((status, payload), (200, {"installed": True, "revision": 7}))

    def test_a_plugin_that_stops_answering_is_refused_closed_after_one_second(self) -> None:
        self.plugin(None)
        status, payload, elapsed = self.install()
        self.assertEqual((status, payload), (503, {"error": "policy_unavailable"}))
        self.assertGreaterEqual(elapsed, 1.0)
        self.assertLess(elapsed, 2.0, "the controller's own 2 s install budget would expire first")


if __name__ == "__main__":
    unittest.main()
