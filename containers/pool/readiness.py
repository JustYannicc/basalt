"""Authenticated boot identity and readiness HTTP endpoint."""

from __future__ import annotations

import datetime as dt
import json
import hmac
import http.server
import re
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Callable

from .pool_contract import native_policy_request
from .runtime_signals import FailureCategory, report_failure


READY_BIND = ("0.0.0.0", 8318)
POLICY_HEALTH_LEASE_NS = 1_500_000_000
POLICY_PLUGIN_ID = "basalt-native-policy"
POLICY_INSTANCE_ID = re.compile(r"^[A-Za-z0-9_-]{32}$")
MAX_POLICY_INSTALL_BYTES = 1 << 20


class Readiness:
    def __init__(
        self,
        management_key: str,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
    ) -> None:
        self.boot_id = str(uuid.uuid4())
        self.started_at = dt.datetime.now(dt.timezone.utc).isoformat(
            timespec="seconds"
        ).replace("+00:00", "Z")
        self._key = management_key.encode("utf-8")
        self._monotonic_ns = monotonic_ns
        self._services_ready = False
        self._policy_healthy = False
        self._policy_deadline_ns = 0
        self._policy_instance_id: str | None = None
        self._fused_instance_id: str | None = None
        self._fused_instance_pending = False
        self._lock = threading.Lock()
        self._probe_condition = threading.Condition()
        self._observed_policy_probes: OrderedDict[str, None] = OrderedDict()

    def set_ready(self, value: bool) -> None:
        with self._lock:
            self._services_ready = value

    def refresh_policy_lease(self, instance_id: str) -> bool:
        if not isinstance(instance_id, str) or not POLICY_INSTANCE_ID.fullmatch(instance_id):
            return False
        with self._lock:
            if self._fused_instance_pending:
                self._fused_instance_id = instance_id
                self._fused_instance_pending = False
            if self._fused_instance_id is not None:
                if instance_id == self._fused_instance_id:
                    self._policy_healthy = False
                    self._policy_deadline_ns = 0
                    return False
                self._fused_instance_id = None
            self._policy_instance_id = instance_id
            self._policy_healthy = True
            self._policy_deadline_ns = self._monotonic_ns() + POLICY_HEALTH_LEASE_NS
            return True

    def invalidate_policy(self) -> None:
        with self._lock:
            self._policy_healthy = False
            self._policy_deadline_ns = 0

    def note_policy_fused(self) -> None:
        with self._lock:
            self._fused_instance_id = self._policy_instance_id
            self._fused_instance_pending = self._policy_instance_id is None
            self._policy_healthy = False
            self._policy_deadline_ns = 0

    def note_policy_probe(self, nonce: str) -> None:
        if not isinstance(nonce, str) or re.fullmatch(r"[A-Za-z0-9_-]{16,96}", nonce) is None:
            return
        with self._probe_condition:
            self._observed_policy_probes[nonce] = None
            self._observed_policy_probes.move_to_end(nonce)
            while len(self._observed_policy_probes) > 64:
                self._observed_policy_probes.popitem(last=False)
            self._probe_condition.notify_all()

    def wait_for_policy_probe(self, nonce: str, timeout_seconds: float) -> bool:
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        with self._probe_condition:
            while nonce not in self._observed_policy_probes:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._probe_condition.wait(remaining)
            del self._observed_policy_probes[nonce]
            return True

    def home_process_restarted(self) -> None:
        with self._lock:
            self._fused_instance_id = None
            self._fused_instance_pending = False
            self._policy_instance_id = None
            self._policy_healthy = False
            self._policy_deadline_ns = 0
        with self._probe_condition:
            self._observed_policy_probes.clear()
            self._probe_condition.notify_all()

    def snapshot(self) -> tuple[bool, dict[str, str]]:
        ready, payload, _ = self.readiness_response()
        return ready, payload

    def readiness_response(self) -> tuple[bool, dict[str, str], int]:
        with self._lock:
            remaining_ns = self._policy_deadline_ns - self._monotonic_ns()
            policy_live = self._policy_healthy and remaining_ns > 0 and not self._fused_instance_pending
            ready = self._services_ready and policy_live
            lease_ms = max(0, min(1500, remaining_ns // 1_000_000)) if ready else 0
        return ready, {"boot_id": self.boot_id, "started_at": self.started_at}, lease_ms

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
        ready, payload, lease_ms = readiness.readiness_response()
        headers = {"X-Signalbox-Policy-Lease-Ms": str(lease_ms)} if ready else None
        self._send(200 if ready else 503, payload, headers)

    def do_POST(self) -> None:
        if self.path != "/native-policy":
            self._send(404, {"error": "not_found"})
            return
        readiness = self.readiness
        if readiness is None or not readiness.authorized(
            self.headers.get("Authorization", "")
        ):
            self._send(401, {"error": "unauthorized"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            content_length = 0
        if content_length < 2 or content_length > MAX_POLICY_INSTALL_BYTES:
            self._send(400, {"error": "invalid_projection"})
            return
        try:
            body = json.loads(self.rfile.read(content_length), object_pairs_hook=_unique_object)
        except (ValueError, TypeError):
            self._send(400, {"error": "invalid_projection"})
            return
        if not isinstance(body, dict) or set(body) != {"projection"} or not isinstance(body["projection"], str):
            self._send(400, {"error": "invalid_projection"})
            return

        status, result = native_policy_request(
            "/install", {"projection": body["projection"]}, timeout=1.0
        )
        revision = result.get("revision")
        if status == 200 and result.get("installed") is True and type(revision) is int and 0 < revision <= (1 << 53) - 1:
            self._send(200, {"installed": True, "revision": revision})
            return
        if status in (400, 409):
            self._send(status, {"error": "invalid_projection"})
            return
        self._send(503, {"error": "policy_unavailable"})

    def _send(
        self,
        status: int,
        payload: dict[str, Any],
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


class ReadyServer(http.server.ThreadingHTTPServer):
    def handle_error(self, request: object, client_address: object) -> None:
        report_failure(FailureCategory.READINESS_HTTP)


def start_ready_server(readiness: Readiness) -> http.server.ThreadingHTTPServer:
    handler = type("BoundReadyHandler", (ReadyHandler,), {"readiness": readiness})
    server = ReadyServer(READY_BIND, handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
