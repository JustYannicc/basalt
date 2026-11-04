"""Closed numeric recovery receipts, separate from child-output capture."""

from __future__ import annotations

import json
import sys


def report_recovery(
    state: str, attempt: int, delay_seconds: int, elapsed_ms: int
) -> None:
    if (
        type(state) is not str
        or state not in ("attempt", "recovered", "exhausted")
        or type(attempt) is not int
        or not 0 <= attempt <= 2
        or type(delay_seconds) is not int
        or delay_seconds not in (0, 1, 5)
        or type(elapsed_ms) is not int
        or not 0 <= elapsed_ms <= 180_000
    ):
        return
    print(
        "POOL_HOME_RECOVERY "
        + json.dumps(
            {
                "state": state,
                "attempt": attempt,
                "delay_seconds": delay_seconds,
                "elapsed_ms": elapsed_ms,
            },
            separators=(",", ":"),
        ),
        file=sys.stderr,
        flush=True,
    )
