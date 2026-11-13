from __future__ import annotations

import json
import os
import socket
import struct
import threading
import unittest
from unittest.mock import patch

from .home_peer import peer_port, pipe_peer
from .home_peer_wire import CHUNK, WINDOW, PeerRefused, PeerWire
from .home_identity import HomeIdentity
from .pool_contract import cluster_yaml


def exact(connection: socket.socket, size: int) -> bytes:
    parts = bytearray()
    while len(parts) < size:
        part = connection.recv(size - len(parts))
        if not part:
            raise EOFError()
        parts.extend(part)
    return bytes(parts)


def send_frame(connection: socket.socket, opcode: int, body: bytes) -> None:
    prefix = bytes([0x80 | opcode, len(body)]) if len(body) < 126 else (
        bytes([0x80 | opcode, 126]) + struct.pack("!H", len(body))
    )
    connection.sendall(prefix + body)


def receive_client(connection: socket.socket) -> tuple[int, bytes]:
    first, second = exact(connection, 2)
    if first & 0xF0 != 0x80 or not second & 0x80:
        raise AssertionError("expected a final masked client frame")
    size = second & 127
    if size == 126:
        size = struct.unpack("!H", exact(connection, 2))[0]
    if size > CHUNK:
        raise AssertionError("client exceeded its frame budget")
    mask = exact(connection, 4)
    return first & 15, bytes(value ^ mask[index % 4] for index, value in enumerate(exact(connection, size)))


class HomePeerTests(unittest.TestCase):
    def test_fleet_homes_have_distinct_advertisements_and_database_names(self):
        configurations = []
        for ordinal in (1, 2, 128):
            with patch.dict(os.environ, {"POOL_HOME_PEER_ORDINAL": str(ordinal)}):
                identity = HomeIdentity.parse(str(ordinal))
                self.assertEqual(identity.port, 8329)
                config = cluster_yaml("postgresql://fixture@database.invalid/pool")
                self.assertIn(f"external-port: {20000 + ordinal}\n", config)
                self.assertIn("  port: 8329\n", config)
                self.assertIn(f"application_name=basalt-home-{ordinal}", config)
                self.assertIn("  max-open-conns: 6\n", config)
                configurations.append(config)
        self.assertEqual(len(set(configurations)), 3)
        self.assertEqual(HomeIdentity.parse(None).port, 8327)
        for value in ("", "0", "129", "-1", "1.0", "01", " 1", "١"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                HomeIdentity.parse(value)

    def test_named_ports_preserve_legacy_without_colliding_with_actual_home(self):
        ports = [peer_port(ordinal) for ordinal in range(129)]
        self.assertEqual(ports[0], 8327)
        self.assertEqual(len(set(ports)), 129)
        self.assertNotIn(8329, ports)
        for ordinal in (-1, 129):
            with self.assertRaises(PeerRefused):
                peer_port(ordinal)

    def test_masked_wire_roundtrips_a_megabyte_and_preserves_tcp_half_close(self):
        client, backend = socket.socketpair()
        wire_client, wire_backend = socket.socketpair()
        for connection in (client, backend, wire_client, wire_backend):
            connection.settimeout(5)
            self.addCleanup(connection.close)
        payload = bytes(range(251)) * 4096
        errors: list[BaseException] = []

        def peer() -> None:
            try:
                send_frame(wire_backend, 1, json.dumps({"credit": WINDOW}).encode())
                reply_credit = 0
                pending = bytearray()
                ended = False
                while True:
                    opcode, body = receive_client(wire_backend)
                    if opcode == 1:
                        message = json.loads(body)
                        if "credit" in message:
                            reply_credit += message["credit"]
                        elif message == {"fin": True}:
                            ended = True
                    else:
                        pending.extend(body)
                        send_frame(wire_backend, 1, json.dumps({"credit": len(body)}).encode())
                    while reply_credit and pending:
                        size = min(CHUNK, reply_credit, len(pending))
                        send_frame(wire_backend, 2, bytes(pending[:size]))
                        del pending[:size]
                        reply_credit -= size
                    if ended and not pending:
                        send_frame(wire_backend, 1, b'{"fin":true}')
                        return
            except BaseException as error:
                errors.append(error)

        def upload() -> None:
            try:
                client.sendall(payload)
                client.shutdown(socket.SHUT_WR)
            except BaseException as error:
                errors.append(error)

        peer_thread = threading.Thread(target=peer)
        relay_thread = threading.Thread(target=pipe_peer, args=(backend, PeerWire(wire_client)))
        upload_thread = threading.Thread(target=upload)
        peer_thread.start()
        relay_thread.start()
        upload_thread.start()
        result = bytearray()
        while True:
            chunk = client.recv(CHUNK)
            if not chunk:
                break
            result.extend(chunk)
        upload_thread.join()
        peer_thread.join()
        relay_thread.join()
        self.assertEqual(errors, [])
        self.assertEqual(bytes(result), payload)

    def test_wire_refuses_oversized_and_fragmented_frames_before_reading_payload(self):
        for frame in (bytes([0x82, 127]), bytes([0x02, 1]), bytes([0x82, 126]) + struct.pack("!H", CHUNK + 1)):
            with self.subTest(frame=frame):
                client, server = socket.socketpair()
                self.addCleanup(server.close)
                wire = PeerWire(client)
                self.addCleanup(wire.close)
                server.sendall(frame)
                with self.assertRaises(PeerRefused):
                    wire.receive()

    def test_wire_answers_ping_without_exposing_it_as_home_bytes(self):
        client, server = socket.socketpair()
        self.addCleanup(server.close)
        wire = PeerWire(client)
        self.addCleanup(wire.close)
        send_frame(server, 9, b"heartbeat")
        send_frame(server, 2, b"home-bytes")
        self.assertEqual(wire.receive(), (2, b"home-bytes"))
        self.assertEqual(receive_client(server), (10, b"heartbeat"))


if __name__ == "__main__":
    unittest.main()
