"""The private peer wire carries bounded opaque frames, never Home credentials."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import socket
import struct
import threading

WINDOW = 64 * 1024
CHUNK = 16 * 1024
PEER_HOST = "home-peer.internal"


class PeerRefused(RuntimeError):
    pass


class PeerWire:
    def __init__(self, connection: socket.socket):
        self.connection = connection
        self.reader = connection.makefile("rb")
        self.write_lock = threading.Lock()

    @classmethod
    def connect(cls, ordinal: int) -> "PeerWire":
        connection = socket.create_connection((PEER_HOST, 80), timeout=10)
        wire = cls(connection)
        try:
            nonce = base64.b64encode(os.urandom(16)).decode("ascii")
            connection.sendall((
                f"GET /peer/{ordinal} HTTP/1.1\r\nHost: {PEER_HOST}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii"))
            if wire.reader.readline(1024).split()[:2] != [b"HTTP/1.1", b"101"]:
                raise PeerRefused("peer handshake refused")
            headers: dict[bytes, bytes] = {}
            for _ in range(32):
                line = wire.reader.readline(1024)
                if line == b"\r\n":
                    break
                if not line.endswith(b"\r\n") or b":" not in line:
                    raise PeerRefused("invalid peer handshake")
                key, value = line.split(b":", 1)
                key = key.strip().lower()
                if key in headers:
                    raise PeerRefused("duplicate peer header")
                headers[key] = value.strip()
            else:
                raise PeerRefused("peer handshake too large")
            expected = base64.b64encode(hashlib.sha1(
                (nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest())
            if (headers.get(b"sec-websocket-accept") != expected
                    or headers.get(b"upgrade", b"").lower() != b"websocket"
                    or b"upgrade" not in headers.get(b"connection", b"").lower().split(b", ")):
                raise PeerRefused("invalid peer upgrade")
            connection.settimeout(None)
            return wire
        except BaseException:
            wire.close()
            raise

    def exact(self, size: int) -> bytes:
        data = self.reader.read(size)
        if len(data) != size:
            raise PeerRefused("peer disconnected")
        return data

    def receive(self) -> tuple[int, bytes]:
        while True:
            first, second = self.exact(2)
            opcode = first & 15
            if first & 0xF0 != 0x80 or second & 0x80:
                raise PeerRefused("invalid peer frame")
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", self.exact(2))[0]
            elif size == 127:
                raise PeerRefused("peer frame too large")
            limit = CHUNK if opcode == 2 else 64 if opcode == 1 else 125
            if size > limit or opcode not in (1, 2, 8, 9, 10):
                raise PeerRefused("invalid peer frame")
            body = self.exact(size)
            if opcode == 8:
                raise PeerRefused("peer closed")
            if opcode == 9:
                self.send(10, body)
            elif opcode != 10:
                return opcode, body

    def send(self, opcode: int, body: bytes) -> None:
        if len(body) > (CHUNK if opcode == 2 else 125):
            raise PeerRefused("peer frame too large")
        mask = os.urandom(4)
        size = len(body)
        header = bytes([0x80 | opcode, 0x80 | size]) if size < 126 else (
            bytes([0x80 | opcode, 0xFE]) + struct.pack("!H", size)
        )
        masked = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
        with self.write_lock:
            self.connection.sendall(header + mask + masked)

    def control(self, value: dict[str, int | bool]) -> None:
        self.send(1, json.dumps(value, separators=(",", ":")).encode("ascii"))

    def close(self) -> None:
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.connection.close()
        self.reader.close()
