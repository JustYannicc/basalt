"""Closed runtime failure and startup timing signals."""

from __future__ import annotations

import json
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from enum import Enum, IntEnum
from types import TracebackType


STARTUP_PHASE_MARKER = "POOL_STARTUP_PHASE "
MAX_STARTUP_PHASE_MS = 86_400_000


class StartupPhase(str, Enum):
    HOME_BOOT = "home_boot"
    BOOTSTRAP_IMPORT = "bootstrap_import"
    CONFIG_APPLY = "config_apply"
    NODE_LAUNCH = "node_launch"
    INITIAL_HEALTH = "initial_health"


class FailureCategory(IntEnum):
    CONFIGURATION = 1
    HOME_STARTUP = 2
    NODE_STARTUP = 3
    INITIAL_HEALTH = 4
    RUNTIME = 5
    UNHANDLED = 6
    THREAD = 7
    READINESS_HTTP = 8
    UNRAISABLE = 9


def try_monotonic_ns() -> int | None:
    try:
        observed_ns = time.monotonic_ns()
    except Exception:
        return None
    return observed_ns if type(observed_ns) is int else None


def _startup_offset_ms(
    supervisor_started_ns: int | None,
    observed_ns: int | None,
) -> int | None:
    if type(supervisor_started_ns) is not int or type(observed_ns) is not int:
        return None
    elapsed_ns = observed_ns - supervisor_started_ns
    if elapsed_ns < 0:
        return None
    elapsed_ms = elapsed_ns // 1_000_000
    return elapsed_ms if elapsed_ms <= MAX_STARTUP_PHASE_MS else None


def report_startup_phase(
    phase: StartupPhase,
    start_ms: int,
    end_ms: int,
) -> None:
    if (
        type(phase) is not StartupPhase
        or type(start_ms) is not int
        or type(end_ms) is not int
        or start_ms < 0
        or end_ms < start_ms
        or end_ms > MAX_STARTUP_PHASE_MS
    ):
        return

    payload = {
        "phase": phase.value,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "duration_ms": end_ms - start_ms,
    }
    try:
        print(
            STARTUP_PHASE_MARKER + json.dumps(payload, separators=(",", ":")),
            file=sys.stdout,
            flush=True,
        )
    except Exception:
        # A diagnostic write must not change pool startup behavior.
        pass


@contextmanager
def startup_phase(
    phase: StartupPhase,
    supervisor_started_ns: int | None,
) -> Iterator[None]:
    started_ns = try_monotonic_ns()
    try:
        yield
    finally:
        ended_ns = try_monotonic_ns()
        start_ms = _startup_offset_ms(supervisor_started_ns, started_ns)
        end_ms = _startup_offset_ms(supervisor_started_ns, ended_ns)
        if start_ms is not None and end_ms is not None:
            report_startup_phase(phase, start_ms, end_ms)


def report_failure(category: FailureCategory) -> None:
    print(
        "POOL_RUNTIME_FAILURE "
        + json.dumps({"category": int(category), "count": 1}, separators=(",", ":")),
        file=sys.stderr,
        flush=True,
    )


def _unhandled_exception(
    error_type: type[BaseException],
    error: BaseException,
    traceback: TracebackType | None,
) -> None:
    report_failure(FailureCategory.UNHANDLED)


def _thread_exception(args: threading.ExceptHookArgs) -> None:
    report_failure(FailureCategory.THREAD)


def _unraisable_exception(args: object) -> None:
    report_failure(FailureCategory.UNRAISABLE)


def install_error_handlers() -> None:
    # Reader threads and cleanup failures must not fall back to raw tracebacks.
    sys.excepthook = _unhandled_exception
    threading.excepthook = _thread_exception
    sys.unraisablehook = _unraisable_exception
