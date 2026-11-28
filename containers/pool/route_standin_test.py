"""Test stand-ins for the route path; never copied into the pool image.

- The I2 relay: the home-peer WebSocket wire at /route/<id>. An id starting
  ``rt_refused`` or ``rt_unassigned`` is closed with 1008 the way PoolRoutePeer refuses a
  route its pool never assigned.
- The I1 gateway: SOCKS5 no-auth CONNECT. An id starting ``rt_down`` gets 0x02,
  as a gateway with its route down does. Only ``allowed`` names are dialled; every
  other CONNECT is refused and recorded, so nothing real leaves a test.
- A DNS server that records every query and answers NXDOMAIN, so any lookup the
  pool makes for itself shows up as a direct call.
- A provider that streams SSE and records who called it.

Run as ``python3 -I route_standin_test.py <allowed-host> <provider-port> [<vendor-cert-dir>]`` for the
container integration; tests import the pieces.
"""

from __future__ import annotations

import base64
import hashlib
import json
import socket
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

WINDOW = 64 * 1024
CHUNK = 16 * 1024


class Records:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.tunnels: list[str] = []
        self.connects: list[dict[str, object]] = []
        self.dns: list[str] = []
        self.provider: list[dict[str, object]] = []
        self.vendor: list[dict[str, object]] = []

    def add(self, kind: str, value: object) -> None:
        with self.lock:
            getattr(self, kind).append(value)

    def snapshot(self) -> dict[str, list[object]]:
        with self.lock:
            return {
                "tunnels": list(self.tunnels),
                "connects": list(self.connects),
                "dns": list(self.dns),
                "provider": list(self.provider),
                "vendor": list(self.vendor),
            }

    def reset(self) -> None:
        with self.lock:
            for items in (self.tunnels, self.connects, self.dns, self.provider, self.vendor):
                items.clear()


def exact(connection: socket.socket, size: int) -> bytes:
    data = bytearray()
    while len(data) < size:
        chunk = connection.recv(size - len(data))
        if not chunk:
            raise EOFError()
        data.extend(chunk)
    return bytes(data)


def send_frame(connection: socket.socket, lock: threading.Lock, opcode: int, body: bytes) -> None:
    head = bytes([0x80 | opcode, len(body)]) if len(body) < 126 else (
        bytes([0x80 | opcode, 126]) + struct.pack("!H", len(body))
    )
    with lock:
        connection.sendall(head + body)


def receive_frame(connection: socket.socket) -> tuple[int, bytes]:
    first, second = exact(connection, 2)
    if not second & 0x80:
        raise ValueError("client frames are masked")
    size = second & 127
    if size == 126:
        size = struct.unpack("!H", exact(connection, 2))[0]
    mask = exact(connection, 4)
    body = exact(connection, size)
    return first & 15, bytes(value ^ mask[index % 4] for index, value in enumerate(body))


# The stand-in vendor: the real provider host name, served here with a throwaway CA's certificate,
# reachable only through the route and only once a test switches it on.
VENDOR = {"on": False, "hosts": {"api.anthropic.com"}, "port": 8443}


def gateway(client: socket.socket, route_id: str, allowed: set[str], records: Records) -> None:
    """One SOCKS5 no-auth CONNECT, as the I1 forwarder answers it."""
    upstream = None
    try:
        version, count = exact(client, 2)
        if version != 5 or 0 not in exact(client, count):
            return
        client.sendall(b"\x05\x00")
        head = exact(client, 4)
        if head[3] == 3:
            host = exact(client, exact(client, 1)[0]).decode("ascii")
        elif head[3] == 1:
            host = socket.inet_ntoa(exact(client, 4))
        else:
            host = socket.inet_ntop(socket.AF_INET6, exact(client, 16))
        port = struct.unpack("!H", exact(client, 2))[0]
        vendor = bool(VENDOR["on"]) and host in VENDOR["hosts"] and port == 443
        refused = head[1] != 1 or route_id.startswith("rt_down") or (host not in allowed and not vendor)
        records.add("connects", {"route": route_id, "host": host, "port": port, "refused": refused})
        if refused:
            client.sendall(bytes([5, 2 if head[1] == 1 else 7, 0, 1, 0, 0, 0, 0, 0, 0]))
            return
        try:
            upstream = socket.create_connection(
                ("127.0.0.1", int(VENDOR["port"])) if vendor else (host, port), timeout=10
            )
        except OSError:
            client.sendall(bytes([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]))
            return
        upstream.settimeout(None)
        client.sendall(bytes([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        splice(client, upstream)
    except (OSError, EOFError, ValueError):
        pass
    finally:
        if upstream is not None:
            upstream.close()
        client.close()


def splice(left: socket.socket, right: socket.socket) -> None:
    def forward(source: socket.socket, destination: socket.socket) -> None:
        try:
            while body := source.recv(CHUNK):
                destination.sendall(body)
            destination.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    other = threading.Thread(target=forward, args=(right, left), daemon=True)
    other.start()
    forward(left, right)
    other.join()


def relay_tunnel(connection: socket.socket, target: socket.socket) -> None:
    """The server half of the home-peer relay: credits follow completed writes."""
    lock = threading.Lock()
    condition = threading.Condition()
    credit = 0
    stopped = False

    def stop() -> None:
        nonlocal stopped
        with condition:
            stopped = True
            condition.notify_all()
        for item in (target, connection):
            try:
                item.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def pump() -> None:
        nonlocal credit
        try:
            while True:
                with condition:
                    condition.wait_for(lambda: stopped or credit > 0)
                    if stopped:
                        return
                    size = min(credit, CHUNK)
                body = target.recv(size)
                if not body:
                    send_frame(connection, lock, 1, b'{"fin":true}')
                    return
                with condition:
                    credit -= len(body)
                send_frame(connection, lock, 2, body)
        except OSError:
            stop()

    sender = threading.Thread(target=pump, daemon=True)
    send_frame(connection, lock, 1, json.dumps({"credit": WINDOW}).encode("ascii"))
    sender.start()
    try:
        while True:
            opcode, body = receive_frame(connection)
            if opcode == 2:
                target.sendall(body)
                send_frame(connection, lock, 1, json.dumps({"credit": len(body)}).encode("ascii"))
            elif opcode == 1:
                message = json.loads(body)
                if "credit" in message:
                    with condition:
                        credit += message["credit"]
                        condition.notify_all()
                elif message == {"fin": True}:
                    target.shutdown(socket.SHUT_WR)
            elif opcode == 8:
                return
    except (OSError, EOFError, ValueError):
        pass
    finally:
        stop()
        sender.join(timeout=5)


def serve_relay(connection: socket.socket, allowed: set[str], records: Records) -> None:
    try:
        reader = connection.makefile("rb")
        request = reader.readline(1024).split()
        headers: dict[bytes, bytes] = {}
        while (line := reader.readline(1024)) not in (b"\r\n", b""):
            key, _, value = line.partition(b":")
            headers[key.strip().lower()] = value.strip()
        path = request[1].decode("ascii") if len(request) > 1 else ""
        if not path.startswith("/route/") or b"sec-websocket-key" not in headers:
            connection.sendall(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        route_id = path.removeprefix("/route/")
        records.add("tunnels", route_id)
        accept = base64.b64encode(hashlib.sha1(
            headers[b"sec-websocket-key"] + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        ).digest())
        connection.sendall(
            b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n"
        )
        # PoolRoutePeer refuses any route its pool never assigned, the placeholder included.
        if route_id.startswith(("rt_refused", "rt_unassigned")):
            send_frame(connection, threading.Lock(), 8, struct.pack("!H", 1008) + b"route_not_permitted")
            return
        near, far = socket.socketpair()
        threading.Thread(target=gateway, args=(far, route_id, allowed, records), daemon=True).start()
        relay_tunnel(connection, near)
        near.close()
    except (OSError, EOFError, ValueError):
        pass
    finally:
        connection.close()


def listen(port: int, handler, *args) -> socket.socket:
    server = socket.create_server(("0.0.0.0", port), backlog=64)

    def accept() -> None:
        while True:
            try:
                client, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=handler, args=(client, *args), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return server


def dns(records: Records, port: int = 53) -> None:
    server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    server.bind(("0.0.0.0", port))
    while True:
        query, address = server.recvfrom(512)
        labels, offset = [], 12
        while offset < len(query) and query[offset]:
            size = query[offset]
            labels.append(query[offset + 1:offset + 1 + size].decode("ascii", "replace"))
            offset += size + 1
        records.add("dns", ".".join(labels))
        # NXDOMAIN, echoing the question.
        server.sendto(query[:2] + b"\x81\x83" + query[4:6] + b"\x00\x00\x00\x00\x00\x00" + query[12:offset + 5], address)


def provider_handler(records: Records):
    class Provider(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args) -> None:
            pass

        def do_POST(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length", "0")))
            records.add("provider", {
                "from": self.client_address[0],
                "path": self.path,
                "key": self.headers.get("Authorization", "") or self.headers.get("x-api-key", ""),
            })
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            for index in range(5):
                event = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture-model",
                         "choices": [{"index": 0, "delta": {"content": f"d{index}"}, "finish_reason": None}]}
                self.chunk(f"data: {json.dumps(event)}\n\n")
                time.sleep(1)
            self.chunk("data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")

        def chunk(self, text: str) -> None:
            body = text.encode()
            self.wfile.write(f"{len(body):x}\r\n".encode() + body + b"\r\n")
            self.wfile.flush()

        def do_GET(self) -> None:
            records.add("provider", {"from": self.client_address[0], "path": self.path, "key": ""})
            body = b'{"object":"list","data":[{"id":"fixture-model","object":"model"}]}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Provider


def control_handler(records: Records):
    class Control(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass

        def do_GET(self) -> None:
            body = json.dumps(records.snapshot()).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            if self.path == "/vendor":
                VENDOR["on"] = True
            else:
                records.reset()
            self.send_response(204)
            self.end_headers()

    return Control


def token_answer(records: Records, issued: dict[str, int], raw: bytes) -> tuple[int, dict[str, object]]:
    """The vendor's token endpoint: a fresh fixture token for a code or a refresh token."""
    try:
        payload = json.loads(raw or b"{}")
    except ValueError:
        payload = {key: values[0] for key, values in parse_qs(raw.decode("latin-1")).items()}
    if not isinstance(payload, dict):
        payload = {}
    grant = payload.get("grant_type")
    presented = payload.get("refresh_token") if grant == "refresh_token" else None
    entry = {"grant": grant, "presented": presented, "issued": None}
    if grant not in ("authorization_code", "refresh_token"):
        records.add("vendor", entry)
        return 404, {"error": "not_found"}
    with records.lock:
        issued["count"] += 1
        n = issued["count"]
    records.add("vendor", {**entry, "issued": n})
    return 200, {
        "access_token": f"fixture-access-{n}",
        "refresh_token": f"fixture-refresh-{n}",
        # Short-lived on purpose: inside Home's refresh lead, so the next refresh comes soon.
        "expires_in": 3600,
        "token_type": "Bearer",
        "account": {"uuid": "fixture-account", "email_address": ""},
        "organization": {"uuid": "fixture-organization", "name": "fixture"},
    }


def h2_frame(kind: int, flags: int, stream: int, body: bytes = b"") -> bytes:
    return struct.pack("!I", len(body))[1:] + bytes([kind, flags]) + struct.pack("!I", stream) + body


def h2_vendor(connection, records: Records, issued: dict[str, int]) -> None:
    """Just enough HTTP/2 for Home's Claude client, which speaks nothing else: every request
    stream is answered by the token endpoint. Header blocks are never decoded; the body says
    what was asked."""
    preface = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"
    if exact(connection, len(preface)) != preface:
        return
    connection.sendall(h2_frame(4, 0, 0))
    bodies: dict[int, bytearray] = {}
    while True:
        head = exact(connection, 9)
        size = int.from_bytes(head[:3], "big")
        kind, flags = head[3], head[4]
        stream = int.from_bytes(head[5:9], "big") & 0x7FFFFFFF
        body = exact(connection, size)
        if kind == 4 and not flags & 1:
            connection.sendall(h2_frame(4, 1, 0))
        elif kind == 6 and not flags & 1:
            connection.sendall(h2_frame(6, 1, 0, body))
        elif kind == 7:
            return
        elif kind in (0, 1):
            if flags & 8:
                body = body[1 : len(body) - body[0]]
            if kind == 1:
                bodies[stream] = bytearray()
            else:
                bodies.setdefault(stream, bytearray()).extend(body)
                if body:
                    # Return the credit so a longer body is never stalled.
                    credit = struct.pack("!I", len(body))
                    connection.sendall(h2_frame(8, 0, 0, credit))
                    if not flags & 1:
                        connection.sendall(h2_frame(8, 0, stream, credit))
            if flags & 1:
                status, value = token_answer(records, issued, bytes(bodies.pop(stream, b"")))
                answer = json.dumps(value).encode()
                # HPACK: indexed :status (200 is entry 8, 404 is 13), then one literal header.
                block = bytes([0x88 if status == 200 else 0x8D]) + b"\x00\x0ccontent-type\x10application/json"
                connection.sendall(h2_frame(1, 4, stream, block) + h2_frame(0, 1, stream, answer))


def serve_vendor(records: Records, directory: str) -> None:
    import ssl

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(f"{directory}/vendor.pem", f"{directory}/vendor-key.pem")
    context.set_alpn_protocols(["h2"])
    listener = socket.create_server(("127.0.0.1", int(VENDOR["port"])))
    issued = {"count": 0}

    def serve(client: socket.socket) -> None:
        try:
            with context.wrap_socket(client, server_side=True) as connection:
                h2_vendor(connection, records, issued)
        except (OSError, EOFError):
            pass

    while True:
        client, _ = listener.accept()
        threading.Thread(target=serve, args=(client,), daemon=True).start()


def main() -> None:
    allowed, provider_port = {sys.argv[1]}, int(sys.argv[2])
    records = Records()
    listen(80, serve_relay, allowed, records)
    threading.Thread(target=dns, args=(records,), daemon=True).start()
    threading.Thread(
        target=ThreadingHTTPServer(("0.0.0.0", provider_port), provider_handler(records)).serve_forever,
        daemon=True,
    ).start()
    if len(sys.argv) > 3:
        threading.Thread(target=serve_vendor, args=(records, sys.argv[3]), daemon=True).start()
    print("ROUTE_STANDIN_READY", flush=True)
    ThreadingHTTPServer(("0.0.0.0", 9090), control_handler(records)).serve_forever()


if __name__ == "__main__":
    main()
