"""Authenticated boot identity and readiness HTTP endpoint."""

from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import http.server
import json
import os
import re
import threading
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from typing import Any

from .output import emit
from .pool_contract import native_policy_request
from .policy_diagnostic import policy_failure
from .runtime_signals import FailureCategory, report_failure

READY_BIND = ("0.0.0.0", 8318)
POLICY_HEALTH_LEASE_NS = 1_500_000_000
POLICY_PLUGIN_ID = "basalt-native-policy"
POLICY_INSTANCE_ID = re.compile(r"^[A-Za-z0-9_-]{32}$")
MAX_POLICY_INSTALL_BYTES = 1 << 20


REFRESH_READING_MAX_AGE_NS = 3_000_000_000

# Closed vocabulary of the lapse and flip records on /ready and in their output lines.
PROBE_STEPS = ("home_plugins", "plugin_probe", "probe_log")
LAPSE_STEPS = PROBE_STEPS + ("node_audit", "no_probe")
LAPSE_LINE = "POOL_READINESS_LAPSE "
FLIP_LINE = "POOL_READINESS_FLIP "


def _emits(method: Callable[..., Any]) -> Callable[..., Any]:
    """Prints the lines a method recorded only after it has left the readiness lock."""

    def wrapper(self: "Readiness", *args: Any, **kwargs: Any) -> Any:
        try:
            return method(self, *args, **kwargs)
        finally:
            self._emit_pending()

    return wrapper


class Readiness:
    def __init__(
        self,
        management_key: str,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
        *,
        launch_generation: str | None = None,
        launch_token: str | None = None,
    ) -> None:
        self._launch_headers: dict[str, str] = {}
        if launch_generation is not None or launch_token is not None:
            if (
                not isinstance(launch_generation, str)
                or re.fullmatch(r"[1-9][0-9]{0,15}", launch_generation) is None
                or int(launch_generation) > (1 << 53) - 1
                or not isinstance(launch_token, str)
                or re.fullmatch(r"[a-f0-9]{64}", launch_token) is None
            ):
                raise ValueError("Invalid pool launch identity")
            self._launch_headers = {
                "X-Signalbox-Launch-Generation": launch_generation,
                "X-Signalbox-Launch-Token-Sha256": hashlib.sha256(
                    launch_token.encode("ascii")
                ).hexdigest(),
            }
        self.boot_id = str(uuid.uuid4())
        self.started_at = (
            dt.datetime.now(dt.timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
        self._key = management_key.encode("utf-8")
        self._monotonic_ns = monotonic_ns
        self._services_ready = False
        self._resume_available = False
        self._database_distance: dict[str, object] = {"db_rtt_state": "pending"}
        location = os.environ.get("CLOUDFLARE_LOCATION", "").strip().lower()
        self._location = location if re.fullmatch(r"[a-z]{3}[0-9]{2}", location) else None
        self._service_audit_revision = 0
        self._policy_observations_enabled = True
        self._diagnostics: Callable[[int], dict[str, object]] | None = None
        self._refresh_in_flight: tuple[int, int] | None = None
        self._policy_healthy = False
        self._policy_deadline_ns = 0
        self._policy_instance_id: str | None = None
        self._fused_instance_id: str | None = None
        self._fused_instance_pending = False
        self._fuse_seen = False
        self._lock = threading.RLock()
        self._probe_condition = threading.Condition(self._lock)
        self._observed_policy_probes: OrderedDict[str, None] = OrderedDict()
        # Lapse and flip bookkeeping: only the last of each and two counters, so a stalled Home
        # cannot grow the answer, and one record and one line per transition, never per probe.
        self._probe_current: tuple[str, int] | None = None
        # Since the last renewal: each step's longest run, and where the latest missed probe stopped.
        self._steps_max: dict[str, int] = {}
        self._last_miss: tuple[str, int] | None = None
        self._policy_renewed_ns = 0
        self._node_audit_ok = True
        self._last_lapse: dict[str, object] | None = None
        self._last_flip: dict[str, object] | None = None
        self._lapses = 0
        self._flips = 0
        self._state_ready = False
        self._state_since_ns = monotonic_ns()
        self._pending_lines: list[str] = []

    def _wall_iso(self, event_ns: int) -> str:
        offset_ns = max(0, self._monotonic_ns() - event_ns)
        at = dt.datetime.fromtimestamp((time.time_ns() - offset_ns) / 1e9, dt.timezone.utc)
        return at.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _current_state(self) -> tuple[bool, str | None]:
        remaining_ns = self._policy_deadline_ns - self._monotonic_ns()
        policy_live = (
            self._policy_healthy and remaining_ns > 0 and not self._fused_instance_pending
        )
        if self._services_ready and policy_live:
            return True, None
        # Closed and ordered: a fused or unproven policy outranks unhealthy services.
        fused = self._fused_instance_pending or self._fused_instance_id is not None
        return False, (
            "policy_fused" if fused else "policy_unproven" if not policy_live else "degraded"
        )

    def _observe_state(self, event_ns: int | None = None) -> tuple[bool, str | None]:
        ready, refusal = self._current_state()
        if ready == self._state_ready:
            return ready, refusal
        at_ns = self._monotonic_ns() if event_ns is None else event_ns
        prior_ms = max(0, (at_ns - self._state_since_ns) // 1_000_000)
        self._state_ready = ready
        self._state_since_ns = at_ns
        self._flips += 1
        record = {
            "to": "ready" if ready else "refusing",
            "reason": "restored" if ready else refusal,
            "prior_ms": prior_ms,
        }
        self._last_flip = {**record, "at": self._wall_iso(at_ns)}
        self._pending_lines.append(FLIP_LINE + json.dumps(record, separators=(",", ":")))
        return ready, refusal

    def _note_lapse(self, step: str, ms: int, event_ns: int) -> None:
        if step not in LAPSE_STEPS:
            return
        record = {"step": step, "ms": max(0, int(ms))}
        self._lapses += 1
        self._last_lapse = {**record, "at": self._wall_iso(event_ns)}
        self._pending_lines.append(LAPSE_LINE + json.dumps(record, separators=(",", ":")))

    def _lapse_cause(self, at_ns: int) -> tuple[str, int]:
        """Where the probe stood when the lease ran out at at_ns, measured to that moment.

        The step still in flight then, else where the latest missed probe stopped, else the
        slowest step since the renewal, else no probe ran at all.
        """
        if self._probe_current is not None:
            step, started_ns = self._probe_current
            if started_ns < at_ns:
                return step, (at_ns - started_ns) // 1_000_000
        if self._last_miss is not None:
            return self._last_miss
        if self._steps_max:
            slowest = max(self._steps_max, key=lambda name: self._steps_max[name])
            return slowest, self._steps_max[slowest]
        return "no_probe", max(0, at_ns - self._policy_renewed_ns) // 1_000_000

    def _emit_pending(self) -> None:
        with self._lock:
            lines, self._pending_lines = self._pending_lines, []
        for line in lines:
            emit(line, err=True)

    def note_probe_step(self, step: str | None, *, missed: bool = False) -> None:
        """Marks where the policy probe is; None ends it, missed when it ended without a lease."""
        with self._lock:
            now = self._monotonic_ns()
            if self._probe_current is not None:
                previous, started_ns = self._probe_current
                took = (now - started_ns) // 1_000_000
                self._steps_max[previous] = max(self._steps_max.get(previous, 0), took)
                if step is None and missed:
                    self._last_miss = (previous, took)
            self._probe_current = (step, now) if step in PROBE_STEPS else None

    @_emits
    def note_node_audit(self, healthy: bool, ms: int) -> None:
        """One lapse when the database-backed node audit starts failing, not one per retry."""
        with self._lock:
            if not healthy and self._node_audit_ok:
                self._note_lapse("node_audit", ms, self._monotonic_ns())
            self._node_audit_ok = bool(healthy)

    @_emits
    def set_ready(self, value: bool, *, audit_revision: int | None = None) -> None:
        with self._lock:
            self._expire_policy_lease()
            self._services_ready = value and (
                audit_revision is None or audit_revision == self._service_audit_revision
            )
            self._observe_state()

    def set_resume_available(self, value: bool) -> None:
        with self._lock:
            self._resume_available = value

    def set_database_distance(self, rtt_ms: int | None) -> None:
        """Home's measured distance to the database; None records a failed measurement."""
        with self._lock:
            self._database_distance = (
                {"db_rtt_state": "failed"}
                if rtt_ms is None
                else {"db_rtt_state": "measured", "db_rtt_ms": rtt_ms}
            )

    @_emits
    def service_audit_revision(self) -> int:
        with self._lock:
            self._expire_policy_lease()
            return self._service_audit_revision

    def _invalidate_service_audit(self) -> None:
        self._services_ready = False
        self._service_audit_revision += 1

    def _expire_policy_lease(self) -> None:
        if self._policy_healthy and self._monotonic_ns() >= self._policy_deadline_ns:
            self._policy_healthy = False
            self._invalidate_service_audit()
            # Expiry is noticed lazily; the records carry the lease's own deadline.
            self._note_lapse(*self._lapse_cause(self._policy_deadline_ns), self._policy_deadline_ns)
            self._observe_state(self._policy_deadline_ns)

    @_emits
    def refresh_policy_lease(
        self, instance_id: str, generation: str | None = None
    ) -> bool:
        if not isinstance(instance_id, str) or not POLICY_INSTANCE_ID.fullmatch(
            instance_id
        ):
            return False
        with self._lock:
            if not self._policy_observations_enabled or (
                generation is not None and generation != self.boot_id
            ):
                return False
            if self._fused_instance_pending:
                self._fused_instance_id = instance_id
                self._fused_instance_pending = False
            if self._fused_instance_id is not None:
                if instance_id == self._fused_instance_id:
                    self._policy_healthy = False
                    self._policy_deadline_ns = 0
                    return False
                self._fused_instance_id = None
            self._expire_policy_lease()
            if self._policy_instance_id is not None and self._policy_instance_id != instance_id:
                self._invalidate_service_audit()
            self._policy_instance_id = instance_id
            self._policy_healthy = True
            self._policy_renewed_ns = self._monotonic_ns()
            self._policy_deadline_ns = self._policy_renewed_ns + POLICY_HEALTH_LEASE_NS
            self._steps_max = {}
            self._last_miss = None
            self._observe_state()
            return True

    @_emits
    def invalidate_policy(self, generation: str | None = None) -> None:
        with self._lock:
            if generation is not None and generation != self.boot_id:
                return
            self._expire_policy_lease()
            if self._policy_healthy:
                self._invalidate_service_audit()
            self._policy_healthy = False
            self._policy_deadline_ns = 0
            self._observe_state()

    @_emits
    def note_policy_fused(self, generation: str | None = None) -> None:
        with self._lock:
            if generation is not None and generation != self.boot_id:
                return
            self._expire_policy_lease()
            self._fused_instance_id = self._policy_instance_id
            self._fused_instance_pending = self._policy_instance_id is None
            self._fuse_seen = True
            self._policy_healthy = False
            self._invalidate_service_audit()
            self._policy_deadline_ns = 0
            self._observe_state()

    def note_policy_probe(self, nonce: str, generation: str | None = None) -> None:
        if (
            not isinstance(nonce, str)
            or re.fullmatch(r"[A-Za-z0-9_-]{16,96}", nonce) is None
        ):
            return
        with self._probe_condition:
            if generation is not None and generation != self.boot_id:
                return
            self._observed_policy_probes[nonce] = None
            self._observed_policy_probes.move_to_end(nonce)
            while len(self._observed_policy_probes) > 64:
                self._observed_policy_probes.popitem(last=False)
            self._probe_condition.notify_all()

    def wait_for_policy_probe(
        self, nonce: str, timeout_seconds: float, generation: str | None = None
    ) -> bool:
        deadline = time.monotonic() + max(0.0, timeout_seconds)
        with self._probe_condition:
            while nonce not in self._observed_policy_probes:
                if generation is not None and generation != self.boot_id:
                    return False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._probe_condition.wait(remaining)
            if generation is not None and generation != self.boot_id:
                return False
            del self._observed_policy_probes[nonce]
            return True

    def generation(self) -> str:
        with self._lock:
            return self.boot_id

    def policy_observation_generation(self) -> str | None:
        with self._lock:
            return self.boot_id if self._policy_observations_enabled else None

    def enable_policy_observations(self) -> None:
        with self._lock:
            self._policy_observations_enabled = True

    def policy_fused(self) -> bool:
        with self._lock:
            return self._fused_instance_pending or self._fused_instance_id is not None

    def fuse_seen(self) -> bool:
        """Whether any fuse was reported for this Home process, even one a newer instance cleared."""
        with self._lock:
            return self._fuse_seen

    @_emits
    def begin_recovery(self) -> None:
        with self._lock:
            if self.policy_fused():
                raise RuntimeError("Policy fuse forbids recovery")
            self._home_process_restarted()

    @_emits
    def home_process_restarted(self) -> None:
        self._home_process_restarted()

    def _home_process_restarted(self) -> None:
        with self._probe_condition:
            self._expire_policy_lease()
            self.boot_id = str(uuid.uuid4())
            self.started_at = (
                dt.datetime.now(dt.timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z")
            )
            self._invalidate_service_audit()
            self._policy_observations_enabled = False
            self._fused_instance_id = None
            self._fused_instance_pending = False
            self._policy_instance_id = None
            self._policy_healthy = False
            self._policy_deadline_ns = 0
            self._observed_policy_probes.clear()
            self._probe_current = None
            self._steps_max = {}
            self._last_miss = None
            self._observe_state()
            self._probe_condition.notify_all()

    def set_diagnostics(self, provider: Callable[[int], dict[str, object]]) -> None:
        self._diagnostics = provider

    def diagnostics(self, after: int) -> dict[str, object] | None:
        provider = self._diagnostics
        return None if provider is None else provider(after)

    def note_refresh_in_flight(self, count: int | None) -> None:
        """Home's count of refreshes it has started and not yet written back; None is unknown."""
        with self._lock:
            self._refresh_in_flight = None if count is None else (count, self._monotonic_ns())

    def _refresh_diagnostics(self) -> dict[str, object]:
        # A reading older than the liveness check's period plus a second is unknown, not quiet.
        if self._refresh_in_flight is None:
            return {}
        count, observed_ns = self._refresh_in_flight
        if self._monotonic_ns() - observed_ns > REFRESH_READING_MAX_AGE_NS:
            return {}
        return {"refresh_in_flight": count}

    def snapshot(self) -> tuple[bool, dict[str, object]]:
        ready, payload, _ = self.readiness_response()
        return ready, payload

    @_emits
    def readiness_response(self) -> tuple[bool, dict[str, object], int]:
        with self._lock:
            self._expire_policy_lease()
            # One state reading serves both the flip record and the answer.
            ready, refusal = self._observe_state()
            remaining_ns = self._policy_deadline_ns - self._monotonic_ns()
            lease_ms = max(0, min(1500, remaining_ns // 1_000_000)) if ready else 0
            # The distance is reported while warming too, so the controller can redraw a far cell.
            payload: dict[str, object] = {"boot_id": self.boot_id, "started_at": self.started_at}
            payload.update(self._database_distance)
            if self._location is not None:
                payload["location"] = self._location
            payload.update(self._refresh_diagnostics())
            if self._resume_available:
                payload["resume"] = "v1"
            if refusal is not None:
                payload["refusal"] = refusal
            # Absent until the first of each since the supervisor started; older images omit them.
            if self._lapses:
                payload["lapses"] = self._lapses
                payload["last_lapse"] = dict(self._last_lapse or {})
            if self._flips:
                payload["flips"] = self._flips
                payload["last_flip"] = dict(self._last_flip or {})
            return ready, payload, lease_ms

    def authorized(self, header: str) -> bool:
        prefix = "Bearer "
        if not header.startswith(prefix):
            return False
        supplied = header[len(prefix) :].encode("utf-8")
        return hmac.compare_digest(supplied, self._key)

    def launch_headers(self) -> dict[str, str]:
        return dict(self._launch_headers)


class ReadyHandler(http.server.BaseHTTPRequestHandler):
    readiness: Readiness | None = None

    def do_GET(self) -> None:
        path, _, query = self.path.partition("?")
        if path == "/diagnostics":
            self._diagnostics(query)
            return
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
        headers = (
            {"X-Signalbox-Policy-Lease-Ms": str(lease_ms), **readiness.launch_headers()}
            if ready
            else None
        )
        self._send(200 if ready else 503, payload, headers)

    def _diagnostics(self, query: str) -> None:
        readiness = self.readiness
        if readiness is None or not readiness.authorized(self.headers.get("Authorization", "")):
            self._send(401, {"error": "unauthorized"})
            return
        after = 0
        if query:
            match = re.fullmatch(r"after=(0|[1-9][0-9]{0,15})", query)
            if match is None:
                self._send(400, {"error": "invalid_query"})
                return
            after = int(match.group(1))
        payload = readiness.diagnostics(after)
        if payload is None:
            self._send(503, {"error": "diagnostics_unavailable"})
            return
        self._send(200, payload)

    def do_POST(self) -> None:
        if self.path not in ("/native-policy", "/native-policy/check"):
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
            self._send(400, {"error": "invalid_projection_framing", "reason": "envelope"})
            return
        if self.path == "/native-policy/check":
            from .policy_check import check_policy

            if content_length > 8192:
                self._send(400, {"ok": False})
                return
            status, payload = check_policy(self.rfile.read(content_length))
            self._send(status, payload)
            return
        try:
            body = json.loads(
                self.rfile.read(content_length), object_pairs_hook=_unique_object
            )
        except (ValueError, TypeError):
            self._send(400, {"error": "invalid_projection_framing", "reason": "json"})
            return
        if (
            not isinstance(body, dict)
            or set(body) != {"projection"}
            or not isinstance(body["projection"], str)
        ):
            self._send(400, {"error": "invalid_projection_framing", "reason": "envelope"})
            return

        status, result = native_policy_request(
            "/install", {"projection": body["projection"]}, timeout=1.0
        )
        revision = result.get("revision")
        if (
            status == 200
            and result.get("installed") is True
            and type(revision) is int
            and 0 < revision <= (1 << 53) - 1
        ):
            self._send(200, {"installed": True, "revision": revision})
            return
        if status in (400, 409):
            self._send(status, policy_failure(result))
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
        # Pooled container clients must not reuse this HTTP/1.0 connection after its FIN.
        self.send_header("Connection", "close")
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
