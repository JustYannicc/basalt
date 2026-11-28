"""Bounded readiness probe for Home's native policy scheduler plugin."""

from __future__ import annotations

import json
import os
import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from .output import emit
from .pool_contract import HOME_URL, native_policy_request, request_json
from .readiness import POLICY_INSTANCE_ID, POLICY_PLUGIN_ID, Readiness

POLICY_REFRESH_SECONDS = 0.5
POLICY_PROBE_TIMEOUT_SECONDS = 0.25
POLICY_PROBE_BUDGET_NS = int(POLICY_PROBE_TIMEOUT_SECONDS * 1_000_000_000)
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


def host_steal(path: str = PROC_STAT) -> tuple[int, int] | None:
    """The time the host took this machine's CPUs from it, summed over them as the kernel counts
    it, and how many CPUs there are, so a reader can set it against wall time; None unread."""
    try:
        with open(path, encoding="ascii") as stat:
            fields = stat.readline().split()
            # The per-CPU lines follow the total; the rest of the file is never read.
            cpus = 0
            for line in stat:
                if not line.startswith("cpu"):
                    break
                cpus += 1
        if not fields or fields[0] != "cpu" or not cpus:
            return None
        return int(fields[8]) * 1000 // _ticks_per_second(), cpus
    except (OSError, ValueError, IndexError):
        return None


def throttled_ms(paths: tuple[str, ...] = CGROUP_CPU_STATS) -> int | None:
    """Time the container's CPU quota held it back, summed over its CPUs as the cgroup counts it:
    cgroup v2's microseconds, v1's nanoseconds."""
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
    cpus: int | None
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
        # Timed from construction, before Home starts, so a first ready is held even before the
        # first wait returns.
        readiness.note_waits_timed()

    def _scheduling(self) -> Scheduling:
        steal, cpus = host_steal(self._proc_stat) or (None, None)
        return Scheduling(
            self._monotonic_ns(),
            self._process_time_ns(),
            steal,
            cpus,
            throttled_ms(self._cpu_stats),
        )

    def wait(self, stop: threading.Event, seconds: float) -> None:
        """The wait between probes. One that returns late is a stall that starved every probe."""
        before = self._scheduling()
        self.readiness.note_wait_started(seconds)
        stop.wait(seconds)
        after = self._scheduling()
        late_ms = (after.at_ns - before.at_ns) // 1_000_000 - int(seconds * 1000)
        if late_ms < STALL_LATE_MS:
            self.readiness.note_wait_on_time()
            return
        self.readiness.note_stall(
            late_ms=late_ms,
            cpu_ms=(after.cpu_ns - before.cpu_ns) // 1_000_000,
            steal_ms=_grew(after.steal_ms, before.steal_ms),
            throttled_ms=_grew(after.throttled_ms, before.throttled_ms),
            cpus=after.cpus,
        )

    def check_once(self) -> ProbeState:
        generation = self.readiness.policy_observation_generation()
        if generation is None:
            return "missed"
        started_ns = self._monotonic_ns()
        state, instance = probe_home_policy(self.management_key, self.readiness)
        # A starved supervisor shows as a slow probe as often as a late wait,
        # so a probe past its budget, or one that renewed no lease, starts the on-time run again.
        steady = self._monotonic_ns() - started_ns <= POLICY_PROBE_BUDGET_NS
        if state == "healthy" and instance is not None:
            if not self.readiness.refresh_policy_lease(instance, generation):
                self.readiness.note_unsteady_probe()
                return "unavailable"
        else:
            steady = False
            if state == "unavailable":
                self.readiness.invalidate_policy(generation)
        if not steady:
            self.readiness.note_unsteady_probe()
        return state

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            started = time.monotonic()
            self.check_once()
            remaining = max(0.0, POLICY_REFRESH_SECONDS - (time.monotonic() - started))
            self.wait(stop, remaining)


# A cell at its CPU allocation in its first seconds starves the probe, so a ready announced then
# lapses seconds later and its calls bounce. The first ready waits until the monitor's last 5 waits
# came back on time with no probe between them slow or failed, about 2.5 s of steady probes. The
# hold ends 30 s after the services audit first passes, so a cell under steady load still serves,
# and gives way 5 s before the start's own deadline, so it never fails a start that would serve.
FIRST_READY_WAITS = 5
FIRST_READY_HOLD_NS = 30_000_000_000
FIRST_READY_DEADLINE_MARGIN_NS = 5_000_000_000
STALL_LATE_NS = STALL_LATE_MS * 1_000_000
SETTLED_LINE = "POOL_READINESS_SETTLED "


class FirstReady:
    """Passes the supervisor's services audits to readiness, holding the process's first ready."""

    def __init__(
        self, readiness: Readiness, monotonic_ns: Callable[[], int] = time.monotonic_ns
    ) -> None:
        self._readiness = readiness
        self._monotonic_ns = monotonic_ns
        self._audit_passed_ns: int | None = None
        self._announced = False

    def set_ready(
        self,
        services_ready: bool,
        *,
        audit_revision: int | None = None,
        remaining_s: float | None = None,
    ) -> bool:
        """Records one services audit; says whether the runtime now answers ready. `remaining_s`
        is the time the start has left before it fails, on the caller's own clock."""
        if self._announced or not services_ready:
            self._readiness.set_ready(services_ready, audit_revision=audit_revision)
            return services_ready and self._readiness.snapshot()[0]
        now = self._monotonic_ns()
        if self._audit_passed_ns is None:
            self._audit_passed_ns = now
        held_ns = now - self._audit_passed_ns
        # None: no monitor times its waits, so there is nothing to wait on and no line.
        timed = self._readiness.waits_on_time() is not None
        if held_ns >= FIRST_READY_HOLD_NS:
            ended = "bound"
        elif (
            remaining_s is not None
            and remaining_s * 1_000_000_000 <= FIRST_READY_DEADLINE_MARGIN_NS
        ):
            ended = "deadline"
        else:
            ended = "on_time"
        if ended == "on_time":
            # Held, the audit is reported as not passed, so /ready answers as before any audit.
            self._readiness.set_ready_if_steady(
                audit_revision=audit_revision, waits=FIRST_READY_WAITS, overdue_ns=STALL_LATE_NS
            )
        else:
            self._readiness.set_ready(True, audit_revision=audit_revision)
        if not self._readiness.snapshot()[0]:
            return False
        self._announced = True
        if timed:
            record = {"held_ms": held_ns // 1_000_000, "ended": ended}
            emit(SETTLED_LINE + json.dumps(record, separators=(",", ":")), err=True)
        return True
