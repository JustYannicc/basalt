"""Closed numeric failures from the Python supervisor and readiness server."""

from __future__ import annotations

import json
import sys
import threading
from enum import IntEnum
from types import TracebackType


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
