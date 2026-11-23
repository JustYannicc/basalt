"""Bounded readiness probe for Home's native policy scheduler plugin."""

from __future__ import annotations

import secrets
import threading
import time
from typing import Literal

from .pool_contract import HOME_URL, native_policy_request, request_json
from .readiness import POLICY_INSTANCE_ID, POLICY_PLUGIN_ID, Readiness

POLICY_REFRESH_SECONDS = 0.5
POLICY_PROBE_TIMEOUT_SECONDS = 0.25
POLICY_HEALTH_PATH = "/v8/management/plugins"

ProbeState = Literal["healthy", "unavailable", "missed"]


def probe_home_policy(
    management_key: str,
    readiness: Readiness,
) -> tuple[ProbeState, str | None]:
    # Readiness times each step, so a lease that lapses names the step that was slow or failed.
    state: ProbeState = "missed"
    try:
        state, instance = _probe_home_policy(management_key, readiness)
        return state, instance
    finally:
        readiness.note_probe_step(None, missed=state != "healthy")


def _probe_home_policy(
    management_key: str,
    readiness: Readiness,
) -> tuple[ProbeState, str | None]:
    generation = readiness.generation()
    deadline = time.monotonic() + POLICY_PROBE_TIMEOUT_SECONDS
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return "missed", None
    readiness.note_probe_step("home_plugins")
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
    readiness.note_probe_step("plugin_probe")
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
    remaining = deadline - time.monotonic()
    readiness.note_probe_step("probe_log")
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

    def check_once(self) -> ProbeState:
        generation = self.readiness.policy_observation_generation()
        if generation is None:
            return "missed"
        state, instance = probe_home_policy(self.management_key, self.readiness)
        if state == "healthy" and instance is not None:
            if not self.readiness.refresh_policy_lease(instance, generation):
                return "unavailable"
        elif state == "unavailable":
            self.readiness.invalidate_policy(generation)
        return state

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            started = time.monotonic()
            self.check_once()
            remaining = max(0.0, POLICY_REFRESH_SECONDS - (time.monotonic() - started))
            stop.wait(remaining)
