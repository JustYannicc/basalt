"""Loopback Home identities route to named runtimes through the private peer binding."""

from __future__ import annotations

import json
import selectors
import socket
import threading
from collections.abc import Callable

from .home_peer_wire import CHUNK, WINDOW, PeerRefused, PeerWire

FIRST_PORT = 20000
MAX_ORDINAL = 128
MAX_CONNECTIONS = 256


def peer_port(ordinal: int) -> int:
    if not 0 <= ordinal <= MAX_ORDINAL:
        raise PeerRefused("invalid Home ordinal")
    return 8327 if ordinal == 0 else FIRST_PORT + ordinal


def pipe_local(local: socket.socket, remote: socket.socket) -> None:
    def forward(source: socket.socket, destination: socket.socket) -> None:
        try:
            while True:
                body = source.recv(CHUNK)
                if not body:
                    destination.shutdown(socket.SHUT_WR)
                    return
                destination.sendall(body)
        except OSError:
            for connection in (source, destination):
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    outgoing = threading.Thread(target=forward, args=(local, remote), daemon=True)
    outgoing.start()
    forward(remote, local)
    outgoing.join()


def pipe_peer(local: socket.socket, wire: PeerWire) -> None:
    condition = threading.Condition()
    pending = bytearray()
    credit = 0
    outstanding = 0
    stopped = False
    sent_fin = False
    received_fin = False
    wrote_fin = False

    def stop() -> None:
        nonlocal stopped
        with condition:
            if stopped:
                return
            stopped = True
            condition.notify_all()
        try:
            local.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        wire.close()

    def send_tcp() -> None:
        nonlocal credit, sent_fin
        try:
            while True:
                with condition:
                    condition.wait_for(lambda: stopped or credit > 0)
                    if stopped:
                        return
                    size = min(credit, CHUNK)
                body = local.recv(size)
                if not body:
                    wire.control({"fin": True})
                    with condition:
                        sent_fin = True
                        finished = wrote_fin
                    if finished:
                        stop()
                    return
                with condition:
                    credit -= len(body)
                wire.send(2, body)
        except (OSError, PeerRefused):
            stop()

    def write_tcp() -> None:
        nonlocal outstanding, wrote_fin
        try:
            while True:
                with condition:
                    condition.wait_for(lambda: stopped or pending or received_fin)
                    if stopped:
                        return
                    body = bytes(pending[:CHUNK])
                    del pending[:len(body)]
                if not body:
                    local.shutdown(socket.SHUT_WR)
                    with condition:
                        wrote_fin = True
                        finished = sent_fin
                    if finished:
                        stop()
                    return
                local.sendall(body)
                with condition:
                    outstanding -= len(body)
                wire.control({"credit": len(body)})
        except (OSError, PeerRefused):
            stop()

    sender = threading.Thread(target=send_tcp, daemon=True)
    writer = threading.Thread(target=write_tcp, daemon=True)
    sender.start()
    writer.start()
    try:
        wire.control({"credit": WINDOW})
        while not stopped:
            opcode, body = wire.receive()
            if opcode == 2:
                with condition:
                    if received_fin or not body or len(body) > WINDOW - outstanding:
                        raise PeerRefused("peer receive window exceeded")
                    outstanding += len(body)
                    pending.extend(body)
                    condition.notify_all()
                continue
            message = json.loads(body)
            if not isinstance(message, dict) or len(message) != 1:
                raise PeerRefused("invalid peer control")
            if "credit" in message:
                amount = message["credit"]
                with condition:
                    if type(amount) is not int or not 1 <= amount <= WINDOW - credit:
                        raise PeerRefused("peer credit exceeded")
                    credit += amount
                    condition.notify_all()
            elif message == {"fin": True} and not received_fin:
                with condition:
                    received_fin = True
                    condition.notify_all()
            else:
                raise PeerRefused("invalid peer control")
    except (OSError, ValueError, PeerRefused):
        pass
    finally:
        stop()
        sender.join()
        writer.join()


class HomePeers:
    def __init__(self, own_ordinal: int, connect: Callable[[int], PeerWire] = PeerWire.connect):
        peer_port(own_ordinal)
        self.connect = connect
        self.own_ordinal = own_ordinal
        self.listeners: list[socket.socket] = []
        self.connections: set[socket.socket] = set()
        self.lock = threading.Lock()
        self.closed = False
        self.wakeup: tuple[socket.socket, socket.socket] | None = None

    def start(self) -> None:
        try:
            for ordinal in range(MAX_ORDINAL + 1):
                # The legacy Home already owns its original loopback address.
                if ordinal == 0 and self.own_ordinal == 0:
                    continue
                listener = socket.create_server(("127.0.0.1", peer_port(ordinal)), backlog=16)
                self.listeners.append(listener)
            self.wakeup = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            threading.Thread(target=self.accept, daemon=True).start()
        except BaseException:
            self.close()
            raise

    def accept(self) -> None:
        assert self.wakeup is not None
        try:
            with selectors.DefaultSelector() as selected:
                selected.register(self.wakeup[0], selectors.EVENT_READ, None)
                ordinals = [n for n in range(MAX_ORDINAL + 1) if n != 0 or self.own_ordinal != 0]
                for listener, ordinal in zip(self.listeners, ordinals):
                    selected.register(listener, selectors.EVENT_READ, ordinal)
                while not self.closed:
                    for ready, _ in selected.select():
                        if ready.data is None or self.closed:
                            return
                        if not isinstance(ready.fileobj, socket.socket):
                            raise OSError("invalid peer listener")
                        local, _ = ready.fileobj.accept()
                        with self.lock:
                            if self.closed or len(self.connections) >= MAX_CONNECTIONS:
                                local.close()
                                continue
                            self.connections.add(local)
                        threading.Thread(target=self.serve, args=(local, ready.data), daemon=True).start()
        except OSError:
            self.close()
        finally:
            for connection in self.wakeup:
                connection.close()

    def serve(self, local: socket.socket, ordinal: int) -> None:
        remote = None
        try:
            if ordinal == self.own_ordinal:
                remote = socket.create_connection(("127.0.0.1", 8329), timeout=10)
                remote.settimeout(None)
                with self.lock:
                    if self.closed:
                        return
                    self.connections.add(remote)
                pipe_local(local, remote)
            else:
                pipe_peer(local, self.connect(ordinal))
        except (OSError, PeerRefused):
            pass
        finally:
            local.close()
            if remote:
                remote.close()
            with self.lock:
                self.connections.discard(local)
                if remote:
                    self.connections.discard(remote)

    def close(self) -> None:
        with self.lock:
            self.closed = True
            if self.wakeup:
                try:
                    self.wakeup[1].send(b"x")
                except OSError:
                    pass
            for connection in [*self.listeners, *self.connections]:
                try:
                    connection.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                connection.close()
