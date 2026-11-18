"""Bounded readiness probe for Home's native policy scheduler plugin."""

from __future__ import annotations

import json
import secrets
import sys
import threading
import time
from typing import Literal

from .pool_contract import HOME_URL, native_policy_request, request_json
from .readiness import POLICY_INSTANCE_ID, POLICY_PLUGIN_ID, Readiness

POLICY_REFRESH_SECONDS = 0.5
POLICY_PROBE_TIMEOUT_SECONDS = 0.25
POLICY_HEALTH_PATH = "/v8/management/plugins"

ProbeState = Literal["healthy", "unavailable", "missed"]
ProbeStage = Literal["plugins", "probe", "observe"]
MAX_PROBE_RECORD_MS = 86_400_000


class ProbeObservation:
    """The last stage a probe reached, so a miss says which Home path was slow."""

    def __init__(self) -> None:
        self.stage: ProbeStage = "plugins"


def probe_home_policy(
    management_key: str,
    readiness: Readiness,
    observation: ProbeObservation | None = None,
) -> tuple[ProbeState, str | None]:
    observation = observation or ProbeObservation()
    generation = readiness.generation()
    deadline = time.monotonic() + POLICY_PROBE_TIMEOUT_SECONDS
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "missed", None
    status, payload = request_json(
        f"{HOME_URL}{POLICY_HEALTH_PATH}",
        "GET",
        management_key,
        timeout=remaining,
    )
    if status != 200:
        return "missed", None
    if payload.get("plugins_enabled") is not True or not isinstance(
        payload.get("plugins"), list
    ):
        return "unavailable", None
    plugin = next(
        (
            item
            for item in payload["plugins"]
            if isinstance(item, dict) and item.get("id") == POLICY_PLUGIN_ID
        ),
        None,
    )
    if plugin is None or any(
        plugin.get(field) is not True
        for field in ("registered", "enabled", "effective_enabled")
    ):
        return "unavailable", None

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "missed", None
    nonce = secrets.token_urlsafe(24)
    observation.stage = "probe"
    status, probe = native_policy_request(
        "/probe",
        {"nonce": nonce},
        timeout=remaining,
    )
    if status == 0:
        return "missed", None
    if (
        status != 200
        or probe.get("ok") is not True
        or probe.get("nonce") != nonce
        or not isinstance(probe.get("instance"), str)
        or POLICY_INSTANCE_ID.fullmatch(probe["instance"]) is None
    ):
        return "unavailable", None
    observation.stage = "observe"
    remaining = deadline - time.monotonic()
    if remaining <= 0 or not readiness.wait_for_policy_probe(
        nonce, remaining, generation
    ):
        return "missed", None
    return "healthy", probe["instance"]


class PolicyHealthMonitor:
    def __init__(
        self,
        readiness: Readiness,
        management_key: str,
    ) -> None:
        self.readiness = readiness
        self.management_key = management_key
        self._missed = 0
        self._missed_max_ms = 0
        self._missed_stage: ProbeStage = "plugins"

    def check_once(self) -> ProbeState:
        generation = self.readiness.policy_observation_generation()
        if generation is None:
            return "missed"
        observation = ProbeObservation()
        started = time.monotonic()
        state, instance = probe_home_policy(self.management_key, self.readiness, observation)
        self._record(state, observation.stage, time.monotonic() - started)
        if state == "healthy" and instance is not None:
            if not self.readiness.refresh_policy_lease(instance, generation):
                return "unavailable"
        elif state == "unavailable":
            self.readiness.invalidate_policy(generation)
        return state

    def _record(self, state: ProbeState, stage: ProbeStage, elapsed_seconds: float) -> None:
        """Two closed records per run of misses: where the first stalled, and how the run ended."""
        elapsed_ms = max(0, min(MAX_PROBE_RECORD_MS, round(elapsed_seconds * 1000)))
        if state == "missed":
            if self._missed == 0:
                _emit("POOL_POLICY_PROBE_MISSED", {"stage": stage, "elapsed_ms": elapsed_ms})
            self._missed += 1
            self._missed_max_ms = max(self._missed_max_ms, elapsed_ms)
            self._missed_stage = stage
            return
        if self._missed:
            _emit(
                "POOL_POLICY_PROBE_MISSES",
                {
                    "missed": self._missed,
                    "max_elapsed_ms": self._missed_max_ms,
                    "last_stage": self._missed_stage,
                    "ended": state,
                    "elapsed_ms": elapsed_ms,
                },
            )
        self._missed = 0
        self._missed_max_ms = 0

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            started = time.monotonic()
            self.check_once()
            remaining = max(0.0, POLICY_REFRESH_SECONDS - (time.monotonic() - started))
            stop.wait(remaining)


def _emit(marker: str, fields: dict[str, int | str]) -> None:
    try:
        print(marker + " " + json.dumps(fields, separators=(",", ":")), file=sys.stderr, flush=True)
    except Exception:
        pass
