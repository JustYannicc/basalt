"""Loopback SOCKS5 for routed credentials: each connection tunnels to its route's gateway.

The node reaches this listener only through a credential's proxy setting, so the
username names the route. The gateway itself decides whether the route is up; a
tunnel that cannot be opened, or closes before the gateway answers, is refused here
so nothing is ever dialled directly.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import socket
import threading
import time
from collections.abc import Callable

from .home_peer import pipe_local, pipe_peer
from .home_peer_wire import PeerRefused, PeerWire

ROUTE_HOST = "route-peer.internal"
ROUTE_PORT = 20990
MAX_CONNECTIONS = 256
HANDSHAKE_SECONDS = 30
# Opaque route ids: "rt_" plus 26 base32 characters.
ROUTE_ID = re.compile(r"rt_[0-9A-Za-z]{26}")

NOT_ALLOWED = 0x02
COMMAND_NOT_SUPPORTED = 0x07


class RouteRefused(RuntimeError):
    pass


class RouteWire(PeerWire):
    """The home-peer wire on its own path. home_peer_wire.py is bundled into retained Homes
    by hash (scripts/pool-peer-program.ts), so the handshake is repeated here, not shared."""

    @classmethod
    def open(cls, route_id: str, host: str = ROUTE_HOST, port: int = 80) -> "RouteWire":
        connection = socket.create_connection((host, port), timeout=10)
        wire = cls(connection)
        try:
            nonce = base64.b64encode(os.urandom(16)).decode("ascii")
            connection.sendall((
                f"GET /route/{route_id} HTTP/1.1\r\nHost: {ROUTE_HOST}\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {nonce}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode("ascii"))
            if wire.reader.readline(1024).split()[:2] != [b"HTTP/1.1", b"101"]:
                raise PeerRefused("route handshake refused")
            headers: dict[bytes, bytes] = {}
            for _ in range(32):
                line = wire.reader.readline(1024)
                if line == b"\r\n":
                    break
                if not line.endswith(b"\r\n") or b":" not in line:
                    raise PeerRefused("invalid route handshake")
                key, value = line.split(b":", 1)
                key = key.strip().lower()
                if key in headers:
                    raise PeerRefused("duplicate route header")
                headers[key] = value.strip()
            else:
                raise PeerRefused("route handshake too large")
            expected = base64.b64encode(hashlib.sha1(
                (nonce + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")
            ).digest())
            if (headers.get(b"sec-websocket-accept") != expected
                    or headers.get(b"upgrade", b"").lower() != b"websocket"
                    or b"upgrade" not in headers.get(b"connection", b"").lower().split(b", ")):
                raise PeerRefused("invalid route upgrade")
            connection.settimeout(None)
            return wire
        except BaseException:
            wire.close()
            raise


def open_route(route_id: str) -> PeerWire:
    return RouteWire.open(route_id)


def exact(connection: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise RouteRefused("socks peer closed")
        data.extend(chunk)
    return bytes(data)


def reply(code: int) -> bytes:
    return bytes([5, code, 0, 1, 0, 0, 0, 0, 0, 0])


def read_connect(connection: socket.socket) -> tuple[int, bytes]:
    """The client's request exactly as sent, so the gateway sees it unchanged."""
    head = exact(connection, 4)
    if head[0] != 5 or head[2] != 0:
        raise RouteRefused("invalid socks request")
    kind = head[3]
    if kind == 1:
        address = exact(connection, 4)
    elif kind == 4:
        address = exact(connection, 16)
    elif kind == 3:
        size = exact(connection, 1)
        if not size[0]:
            raise RouteRefused("invalid socks domain")
        address = size + exact(connection, size[0])
    else:
        raise RouteRefused("invalid socks address")
    return head[1], head + address + exact(connection, 2)


def read_reply(connection: socket.socket) -> bytes:
    head = exact(connection, 4)
    if head[0] != 5 or head[2] != 0:
        raise RouteRefused("invalid gateway reply")
    kind = head[3]
    if kind == 1:
        size = 4
    elif kind == 4:
        size = 16
    elif kind == 3:
        size = exact(connection, 1)[0]
        head += bytes([size])
    else:
        raise RouteRefused("invalid gateway reply")
    return head + exact(connection, size + 2)


def authenticate(client: socket.socket) -> str:
    """RFC 1929 only: the username is the route id, the password is ignored."""
    version, count = exact(client, 2)
    if version != 5 or not count or 2 not in exact(client, count):
        client.sendall(b"\x05\xff")
        raise RouteRefused("socks method refused")
    client.sendall(b"\x05\x02")
    version, size = exact(client, 2)
    name = exact(client, size).decode("ascii", "replace") if size else ""
    exact(client, exact(client, 1)[0])
    if version != 1 or not ROUTE_ID.fullmatch(name):
        client.sendall(b"\x01\x01")
        raise RouteRefused("socks route refused")
    client.sendall(b"\x01\x00")
    return name


class RoutePeers:
    def __init__(self, open_tunnel: Callable[[str], PeerWire] = open_route, port: int = ROUTE_PORT):
        self.open_tunnel = open_tunnel
        self.port = port
        self.listener: socket.socket | None = None
        self.connections: set[socket.socket] = set()
        # One per tunnel; each tunnel holds three sockets, so the sockets aren't the measure.
        self.clients = 0
        self.lock = threading.Lock()
        self.closed = False

    def start(self) -> None:
        self.listener = socket.create_server(("127.0.0.1", self.port), backlog=64)
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self) -> None:
        listener = self.listener
        assert listener is not None
        while not self.closed:
            try:
                client, _ = listener.accept()
            except OSError:
                # A transient failure (too many open files, an aborted handshake) keeps the
                # listener; only close() ends it.
                if self.closed:
                    return
                time.sleep(0.05)
                continue
            with self.lock:
                if self.closed or self.clients >= MAX_CONNECTIONS:
                    client.close()
                    continue
                self.clients += 1
                self.connections.add(client)
            threading.Thread(target=self.serve, args=(client,), daemon=True).start()

    @staticmethod
    def relay(remote: socket.socket, wire: PeerWire) -> None:
        try:
            pipe_peer(remote, wire)
        finally:
            # pipe_peer only shuts its end down, and on macOS a send to a shut-down socketpair
            # peer blocks instead of failing; closing it makes a refused tunnel fail at once.
            remote.close()

    def serve(self, client: socket.socket) -> None:
        local = remote = None
        try:
            client.settimeout(HANDSHAKE_SECONDS)
            route_id = authenticate(client)
            command, request = read_connect(client)
            if command != 1:
                client.sendall(reply(COMMAND_NOT_SUPPORTED))
                return
            try:
                wire = self.open_tunnel(route_id)
            except (OSError, PeerRefused):
                client.sendall(reply(NOT_ALLOWED))
                return
            local, remote = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            with self.lock:
                if self.closed:
                    wire.close()
                    return
                self.connections.update((local, remote))
            threading.Thread(target=self.relay, args=(remote, wire), daemon=True).start()
            local.settimeout(HANDSHAKE_SECONDS)
            try:
                local.sendall(b"\x05\x01\x00")
                if exact(local, 2) != b"\x05\x00":
                    raise RouteRefused("gateway method refused")
                local.sendall(request)
                answer = read_reply(local)
            except (OSError, RouteRefused):
                # A tunnel the gateway closed before answering never becomes a direct dial.
                client.sendall(reply(NOT_ALLOWED))
                return
            client.sendall(answer)
            if answer[1] != 0:
                return
            client.settimeout(None)
            local.settimeout(None)
            pipe_local(client, local)
        except (OSError, RouteRefused):
            pass
        finally:
            for connection in (client, local, remote):
                if connection is None:
                    continue
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()
            with self.lock:
                self.clients -= 1
                self.connections.difference_update((client, local, remote))

    def close(self) -> None:
        with self.lock:
            self.closed = True
            open_connections = list(self.connections)
            listener, self.listener = self.listener, None
        if listener is not None:
            try:
                listener.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            listener.close()
        for connection in open_connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            connection.close()

