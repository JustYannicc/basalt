"""Recovery control calls obey the episode deadline, including response reads."""

import json
import socket
import threading
import unittest
from unittest.mock import Mock, patch

from . import recovery_http
from .recovery_deadline import RecoveryDeadline, RecoveryTimeout
from .test_recovery import Clock, Stop


class RecoveryHTTPTests(unittest.TestCase):
    def test_real_http_response_can_close_connection_without_losing_body(self):
        client, server = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(server.close)
        server.sendall(
            b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}'
        )
        deadline = RecoveryDeadline(Stop(Clock()))

        class PairConnection(recovery_http.http.client.HTTPConnection):
            def connect(self):
                self.sock = client

        with patch.object(recovery_http.http.client, "HTTPConnection", PairConnection):
            self.assertEqual(
                recovery_http.request_with_deadline(
                    "http://127.0.0.1:8327/v8/management/config",
                    "GET",
                    None,
                    {},
                    2,
                    deadline,
                ),
                (200, {"ok": True}),
            )

    def test_response_reads_share_remaining_episode_budget(self):
        clock = Clock()
        stop = Stop(clock)
        deadline = RecoveryDeadline(stop, clock)
        clock.now = 175
        connection = Mock()
        response = connection.getresponse.return_value

        def read_chunk(*args):
            clock.now += 1
            return b"x"

        response.read1.side_effect = read_chunk
        with (
            patch.object(
                recovery_http.http.client, "HTTPConnection", return_value=connection
            ),
            patch.object(recovery_http.time, "monotonic", clock),
            self.assertRaises(RecoveryTimeout),
        ):
            recovery_http.request_with_deadline(
                "http://127.0.0.1:8327/config", "GET", None, {}, 10, deadline
            )
        self.assertEqual(response.read1.call_count, 2)
        timeouts = [args.args[0] for args in connection.sock.settimeout.call_args_list]
        self.assertEqual(timeouts, [2, 2, 2, 1])
        connection.close.assert_called_once()

    def test_recovery_refuses_external_or_unexpected_ports(self):
        deadline = RecoveryDeadline(Stop(Clock()))
        for url in (
            "https://outside.invalid/config",
            "http://127.0.0.1:80/config",
            "http://localhost:8327/config",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                recovery_http.request_with_deadline(url, "GET", None, {}, 2, deadline)

    def test_http_failure_preserves_its_status_for_management_checks(self):
        clock = Clock()
        connection = Mock()
        response = connection.getresponse.return_value
        response.status = 503
        response.read1.side_effect = [
            json.dumps({"error": "unavailable"}).encode(),
            b"",
        ]
        with (
            patch.object(
                recovery_http.http.client, "HTTPConnection", return_value=connection
            ),
            patch.object(recovery_http.time, "monotonic", clock),
        ):
            self.assertEqual(
                recovery_http.request_with_deadline(
                    "http://127.0.0.1:8327/config",
                    "GET",
                    None,
                    {},
                    2,
                    RecoveryDeadline(Stop(clock), clock),
                ),
                (503, {"error": "unavailable"}),
            )

    def test_absolute_deadline_interrupts_a_partial_http_header(self):
        client, server = socket.socketpair()
        self.addCleanup(client.close)
        self.addCleanup(server.close)
        partial_header = threading.Event()
        finished = threading.Event()

        def serve_partial_header():
            try:
                request = b""
                while b"\r\n\r\n" not in request:
                    request += server.recv(4096)
                server.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n")
                partial_header.set()
            finally:
                finished.set()

        server_thread = threading.Thread(target=serve_partial_header, daemon=True)
        server_thread.start()
        timers = []

        class PairConnection(recovery_http.http.client.HTTPConnection):
            def connect(self):
                self.sock = client

        class ControlledTimer:
            def __init__(self, seconds, expire):
                self.seconds = seconds
                self.cancelled = False
                self.thread = threading.Thread(
                    target=self.run, args=(expire,), daemon=True
                )
                timers.append(self)

            def run(self, expire):
                if partial_header.wait(1):
                    expire()

            def start(self):
                self.thread.start()

            def cancel(self):
                self.cancelled = True

        with (
            patch.object(recovery_http.http.client, "HTTPConnection", PairConnection),
            patch.object(recovery_http.threading, "Timer", ControlledTimer),
        ):
            result = recovery_http.request_with_deadline(
                "http://127.0.0.1:8327/config",
                "GET",
                None,
                {},
                2,
                RecoveryDeadline(Stop(Clock())),
            )
        server_thread.join(timeout=1)
        timers[0].thread.join(timeout=1)
        self.assertTrue(finished.is_set())
        self.assertFalse(timers[0].thread.is_alive())
        self.assertTrue(0 < timers[0].seconds <= 2)
        self.assertTrue(timers[0].cancelled)
        self.assertEqual(result, (0, {}))
