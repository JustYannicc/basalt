"""Authenticated boot identity and readiness HTTP endpoint."""

from __future__ import annotations

import datetime as dt
import hmac
import http.server
import json
import threading
import uuid


READY_BIND = ("0.0.0.0", 8318)


class Readiness:
    def __init__(self, management_key: str) -> None:
        self.boot_id = str(uuid.uuid4())
        self.started_at = dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
        self._key = management_key.encode("utf-8")
        self._ready = False
        self._lock = threading.Lock()

    def set_ready(self, value: bool) -> None:
        with self._lock:
            self._ready = value

    def snapshot(self) -> tuple[bool, dict[str, str]]:
        with self._lock:
            ready = self._ready
        return ready, {"boot_id": self.boot_id, "started_at": self.started_at}

    def authorized(self, header: str) -> bool:
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        supplied = header[len(prefix):].encode("utf-8")
        return hmac.compare_digest(supplied, self._key)


class ReadyHandler(http.server.BaseHTTPRequestHandler):
    readiness: Readiness | None = None

    def do_GET(self) -> None:
        if self.path != "/ready":
            self._send(404, {"error": "not_found"})
            return
        readiness = self.readiness
        if readiness is None or not readiness.authorized(
            self.headers.get("Authorization", "")
        ):
            self._send(401, {"error": "unauthorized"})
            return
        ready, payload = readiness.snapshot()
        self._send(200 if ready else 503, payload)

    def _send(self, status: int, payload: dict[str, str]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def start_ready_server(readiness: Readiness) -> http.server.ThreadingHTTPServer:
    handler = type("BoundReadyHandler", (ReadyHandler,), {"readiness": readiness})
    server = http.server.ThreadingHTTPServer(READY_BIND, handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
