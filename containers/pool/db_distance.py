"""Network distance to the database pooler, measured once per supervisor start before Home starts.

Plain TCP handshakes only: no TLS, no startup packet, no login. The controller decides what a
distance means; the supervisor only holds Home back when the controller asked it to for this start.
"""

from __future__ import annotations

import json
import math
import os
import re
import socket
import statistics
import sys
import threading
import time
import urllib.parse
from collections.abc import Callable, Mapping
from typing import Any, Literal
from dataclasses import dataclass

ATTEMPTS = 7
MIN_SAMPLES = 3
ATTEMPT_TIMEOUT_NS = 500_000_000
TOTAL_BUDGET_NS = 3_500_000_000
MAX_RTT_MS = 3_500
HOLD_ENV = "POOL_DB_RTT_HOLD_MS"
DATABASE_URL_ENV = "POOL_DATABASE_URL"
LOCATION_ENV = "CLOUDFLARE_LOCATION"
LOCATION = re.compile(r"[a-z]{3}[0-9]{2}")
HOLD = re.compile(r"[1-9][0-9]{0,3}")


@dataclass(frozen=True)
class Distance:
    state: Literal["measured", "failed", "held"]
    rtt_ms: int | None
    max_ms: int | None
    samples: int

    def fields(self) -> dict[str, object]:
        fields: dict[str, object] = {"db_rtt_state": self.state, "db_rtt_samples": self.samples}
        if self.rtt_ms is not None and self.max_ms is not None:
            fields["db_rtt_ms"] = self.rtt_ms
            fields["db_rtt_max_ms"] = self.max_ms
        return fields


def location(environment: Mapping[str, str]) -> str | None:
    value = environment.get(LOCATION_ENV, "")
    return value if LOCATION.fullmatch(value) else None


def hold_bound(environment: Mapping[str, str]) -> int | None:
    value = environment.get(HOLD_ENV, "")
    if HOLD.fullmatch(value) is None or int(value) > MAX_RTT_MS:
        return None
    return int(value)


def _milliseconds(nanoseconds: int) -> int:
    return min(MAX_RTT_MS, max(1, math.ceil(nanoseconds / 1_000_000)))


def _within(work: Callable[[], Any], timeout_s: float) -> Any:
    """Run a blocking call with a deadline; None on error or timeout (the thread is abandoned)."""
    result: list[Any] = []

    def run() -> None:
        try:
            result.append(work())
        except (OSError, ValueError):
            pass

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    thread.join(timeout_s)
    return result[0] if result else None


def measure(
    host: str,
    port: int,
    hold_ms: int | None,
    *,
    clock: Callable[[], int] = time.monotonic_ns,
    connect: Callable[[tuple[str, int], float], socket.socket] | None = None,
) -> Distance:
    deadline = clock() + TOTAL_BUDGET_NS
    samples: list[int] = []
    for _ in range(ATTEMPTS):
        remaining = deadline - clock()
        if remaining <= 0:
            break
        timeout = min(ATTEMPT_TIMEOUT_NS, remaining) / 1e9

        def attempt() -> int:
            started = clock()
            # Each sample includes the name lookup, as every new Home connection does.
            connection = (
                socket.create_connection((host, port), timeout=timeout)
                if connect is None
                else connect((host, port), timeout)
            )
            elapsed = clock() - started
            connection.close()
            return elapsed

        # The thread bound also covers a stalled lookup, which the socket timeout does not.
        elapsed = _within(attempt, timeout)
        if elapsed is not None:
            samples.append(elapsed)
    if len(samples) < MIN_SAMPLES:
        return Distance("failed", None, None, len(samples))
    rtt_ms = _milliseconds(int(statistics.median(samples)))
    state = "held" if hold_ms is not None and rtt_ms > hold_ms else "measured"
    return Distance(state, rtt_ms, _milliseconds(max(samples)), len(samples))


def measure_database() -> Distance:
    """Dial exactly the host the model declares as the pool database's address."""
    try:
        host = urllib.parse.urlsplit(os.environ[DATABASE_URL_ENV]).hostname
        port = urllib.parse.urlsplit(os.environ[DATABASE_URL_ENV]).port or 5432
    except (KeyError, ValueError):
        return Distance("failed", None, None, 0)
    if not host:
        return Distance("failed", None, None, 0)
    return measure(host, port, hold_bound(os.environ))


def report(distance: Distance, where: str | None) -> None:
    payload = {
        "state": distance.state,
        "rtt_ms": distance.rtt_ms,
        "max_ms": distance.max_ms,
        "samples": distance.samples,
        "location": where,
    }
    try:
        print(
            "POOL_DB_DISTANCE " + json.dumps(payload, separators=(",", ":")),
            file=sys.stdout,
            flush=True,
        )
    except (OSError, ValueError):
        pass
