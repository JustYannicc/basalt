"""Bounded readiness probe for Home's native policy scheduler plugin."""

from __future__ import annotations

import os
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
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


PROC_STAT = "/proc/stat"
CGROUP_CPU_STATS = ("/sys/fs/cgroup/cpu.stat", "/sys/fs/cgroup/cpu/cpu.stat")
# A wait this late is no scheduling jitter, and well inside the second of slack the 1.5 s lease
# leaves a 0.5 s renewal, so every stall that can lapse the lease is recorded.
STALL_LATE_MS = 250


def _ticks_per_second() -> int:
    try:
        return int(os.sysconf("SC_CLK_TCK")) or 100
    except (AttributeError, OSError, ValueError):
        return 100


def steal_ms(path: str = PROC_STAT) -> int | None:
    """Time the host took this machine's CPUs from it, from the kernel's counter; None unread."""
    try:
        with open(path, encoding="ascii") as stat:
            fields = stat.readline().split()
        if not fields or fields[0] != "cpu":
            return None
        return int(fields[8]) * 1000 // _ticks_per_second()
    except (OSError, ValueError, IndexError):
        return None


def throttled_ms(paths: tuple[str, ...] = CGROUP_CPU_STATS) -> int | None:
    """Time the container's CPU quota held it back: cgroup v2's microseconds, v1's nanoseconds."""
    for path in paths:
        try:
            with open(path, encoding="ascii") as stat:
                values = dict(line.split(None, 1) for line in stat if len(line.split()) == 2)
        except (OSError, ValueError):
            continue
        try:
            if "throttled_usec" in values:
                return int(values["throttled_usec"]) // 1_000
            if "throttled_time" in values:
                return int(values["throttled_time"]) // 1_000_000
        except ValueError:
            return None
    return None


@dataclass(frozen=True)
class Scheduling:
    at_ns: int
    cpu_ns: int
    steal_ms: int | None
    throttled_ms: int | None


def _grew(after: int | None, before: int | None) -> int | None:
    return None if after is None or before is None else max(0, after - before)


class PolicyHealthMonitor:
    def __init__(
        self,
        readiness: Readiness,
        management_key: str,
        *,
        monotonic_ns: Callable[[], int] = time.monotonic_ns,
        process_time_ns: Callable[[], int] = time.process_time_ns,
        proc_stat: str = PROC_STAT,
        cpu_stats: tuple[str, ...] = CGROUP_CPU_STATS,
    ) -> None:
        self.readiness = readiness
        self.management_key = management_key
        # Bound here, so a caller that swaps this module's `time` to drive the loop leaves them be.
        self._monotonic_ns = monotonic_ns
        self._process_time_ns = process_time_ns
        self._proc_stat = proc_stat
        self._cpu_stats = cpu_stats

    def _scheduling(self) -> Scheduling:
        return Scheduling(
            self._monotonic_ns(),
            self._process_time_ns(),
            steal_ms(self._proc_stat),
            throttled_ms(self._cpu_stats),
        )

    def wait(self, stop: threading.Event, seconds: float) -> None:
        """The wait between probes. One that returns late is a stall that starved every probe."""
        before = self._scheduling()
        stop.wait(seconds)
        after = self._scheduling()
        late_ms = (after.at_ns - before.at_ns) // 1_000_000 - int(seconds * 1000)
        if late_ms < STALL_LATE_MS:
            return
        self.readiness.note_stall(
            late_ms=late_ms,
            cpu_ms=(after.cpu_ns - before.cpu_ns) // 1_000_000,
            steal_ms=_grew(after.steal_ms, before.steal_ms),
            throttled_ms=_grew(after.throttled_ms, before.throttled_ms),
            at_ns=after.at_ns,
        )

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
            self.wait(stop, remaining)
