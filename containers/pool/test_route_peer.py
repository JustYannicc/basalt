from __future__ import annotations

import socket
import struct
import threading
import unittest

from .home_peer_wire import PeerRefused
from .route_peer import RoutePeers, RouteWire
from .route_standin_test import Records, listen, serve_relay

ROUTED = "rt_" + "a" * 26
REFUSED = "rt_refused" + "a" * 19
DOWN = "rt_down" + "a" * 22


def exact(connection: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


def connect_request(host: str, port: int) -> bytes:
    name = host.encode("ascii")
    return b"\x05\x01\x00\x03" + bytes([len(name)]) + name + struct.pack("!H", port)


class RoutePeerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.records = Records()
        # The provider stand-in: echoes until the client half-closes, recording each caller.
        self.provider = socket.create_server(("127.0.0.1", 0))
        self.addCleanup(self.provider.close)
        self.provider_calls = 0

        def echo() -> None:
            while True:
                try:
                    peer, _ = self.provider.accept()
                except OSError:
                    return
                self.provider_calls += 1
                with peer:
                    while body := peer.recv(65536):
                        peer.sendall(body)

        threading.Thread(target=echo, daemon=True).start()
        self.provider_port = self.provider.getsockname()[1]
        self.relay = listen(0, serve_relay, {"localhost"}, self.records)
        self.addCleanup(self.relay.close)
        relay_port = self.relay.getsockname()[1]
        self.opened: list[str] = []

        def open_tunnel(route_id: str):
            self.opened.append(route_id)
            return RouteWire.open(route_id, "127.0.0.1", relay_port)

        self.peers = RoutePeers(open_tunnel, 0)
        self.peers.start()
        self.addCleanup(self.peers.close)
        assert self.peers.listener is not None
        self.address = self.peers.listener.getsockname()

    def client(self, user: str = ROUTED, methods: bytes = b"\x02") -> socket.socket:
        connection = socket.create_connection(self.address, timeout=10)
        self.addCleanup(connection.close)
        connection.sendall(b"\x05" + bytes([len(methods)]) + methods)
        self.method = exact(connection, 2)
        if self.method != b"\x05\x02":
            return connection
        name = user.encode("ascii")
        connection.sendall(b"\x01" + bytes([len(name)]) + name + b"\x01x")
        return connection

    def test_routed_connect_reaches_the_provider_only_through_the_tunnel_unresolved(self):
        connection = self.client()
        self.assertEqual(exact(connection, 2), b"\x01\x00")
        connection.sendall(connect_request("localhost", self.provider_port))
        self.assertEqual(exact(connection, 10)[:2], b"\x05\x00")
        payload = bytes(range(256)) * 4096
        sender = threading.Thread(target=lambda: (connection.sendall(payload), connection.shutdown(socket.SHUT_WR)))
        sender.start()
        received = bytearray()
        while body := connection.recv(65536):
            received.extend(body)
        sender.join()
        self.assertEqual(bytes(received), payload)
        self.assertEqual(self.opened, [ROUTED])
        connects = self.records.snapshot()["connects"]
        # The name travels to the gateway unresolved, so the lookup happens on the exit side.
        self.assertEqual(connects, [{"route": ROUTED, "host": "localhost", "port": self.provider_port, "refused": False}])
        self.assertEqual(self.provider_calls, 1)

    def assert_refused_before_any_dial(self, user: str) -> None:
        connection = self.client(user)
        self.assertEqual(exact(connection, 2), b"\x01\x00")
        connection.sendall(connect_request("localhost", self.provider_port))
        self.assertEqual(exact(connection, 10)[:2], b"\x05\x02")
        self.assertEqual(connection.recv(1), b"")
        self.assertEqual(self.provider_calls, 0)

    def test_a_refused_tunnel_answers_not_allowed_and_never_dials(self):
        self.assert_refused_before_any_dial(REFUSED)
        self.assertEqual(self.records.snapshot()["connects"], [])

    def test_a_gateway_with_its_route_down_answers_not_allowed(self):
        self.assert_refused_before_any_dial(DOWN)
        self.assertTrue(self.records.snapshot()["connects"][0]["refused"])

    def test_a_tunnel_that_cannot_open_answers_not_allowed(self):
        def unreachable(_route_id: str):
            raise PeerRefused("route handshake refused")

        self.peers.open_tunnel = unreachable
        self.assert_refused_before_any_dial(ROUTED)

    def test_only_username_auth_with_a_route_id_is_accepted(self):
        connection = self.client(methods=b"\x00")
        self.assertEqual(self.method, b"\x05\xff")
        self.assertEqual(connection.recv(1), b"")
        for user in ("", "rt_short", "rt_" + "a" * 27, "../" + "a" * 26, "rt_" + "a" * 25 + "/"):
            with self.subTest(user=user):
                connection = self.client(user)
                self.assertEqual(exact(connection, 2), b"\x01\x01")
                self.assertEqual(connection.recv(1), b"")
        self.assertEqual(self.opened, [])

    def test_only_connect_is_tunnelled(self):
        connection = self.client()
        self.assertEqual(exact(connection, 2), b"\x01\x00")
        connection.sendall(b"\x05\x02\x00\x01\x7f\x00\x00\x01\x00\x50")
        self.assertEqual(exact(connection, 10)[:2], b"\x05\x07")
        self.assertEqual(self.opened, [])


if __name__ == "__main__":
    unittest.main()
