"""Closed database signals: slow statements and Home's connection pool counters.

Statement text and values never leave the container. A slow statement becomes its duration and a
fingerprint of its normalized text, so repeats of one query shape share a fingerprint.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from collections.abc import Callable
from typing import Any

from .child_signals import MAX_HOME_SIGNAL_INTEGER
from .output import emit
from .pool_contract import HOME_URL, request_json

SLOW_STATEMENT_MARKER = "POOL_HOME_SLOW_SQL "
DATABASE_POOL_MARKER = "POOL_HOME_DB_POOL "
MAX_ELAPSED_MS = 3_600_000
SLOW_STATEMENT = re.compile(
    r"SLOW SQL >= \S+ \[(?P<ms>[0-9]{1,9}(?:\.[0-9]{1,6})?)ms\] \[rows:(?:-|[0-9]{1,19})\] (?P<sql>.+)"
)
_QUOTED = re.compile(r"'(?:[^']|'')*'")
_NUMBER = re.compile(r"(?<![a-z_])[0-9]+(?:\.[0-9]+)?")
_PLACEHOLDER = re.compile(r"\$[0-9]+|\?")
_LIST = re.compile(r"\(\s*\?(?:\s*,\s*\?)*\s*\)")
_ROWS = re.compile(r"\(\?\)(?:\s*,\s*\(\?\))+")
_SPACE = re.compile(r"\s+")
POOL_FIELDS = {
    "max_open_connections": "max_open",
    "open_connections": "open",
    "in_use": "in_use",
    "idle": "idle",
    "wait_count": "wait_count",
}


def statement_fingerprint(sql: str) -> str:
    shape = _QUOTED.sub("?", sql.lower())
    shape = _NUMBER.sub("?", _PLACEHOLDER.sub("?", shape))
    shape = _LIST.sub("(?)", _SPACE.sub(" ", shape).strip())
    shape = _ROWS.sub("(?)", shape)
    return hashlib.sha256(shape.encode("utf-8")).hexdigest()[:16]


def slow_statement(message: str | None, truncated: bool = False) -> tuple[int, str] | None:
    if message is None:
        return None
    match = SLOW_STATEMENT.fullmatch(message.strip())
    if match is None:
        return None
    elapsed = min(MAX_ELAPSED_MS, max(1, math.ceil(float(match.group("ms")))))
    sql = match.group("sql")
    if truncated:
        # A cut line ends inside a row or value; keep the complete rows so the shape stays stable.
        sql = sql[: sql.rfind(")") + 1] or sql
    return elapsed, statement_fingerprint(sql)


def slow_statement_line(elapsed_ms: int, fingerprint: str) -> str:
    return SLOW_STATEMENT_MARKER + json.dumps(
        {"elapsed_ms": elapsed_ms, "statement": fingerprint}, separators=(",", ":")
    )


def database_pool(capabilities: Any) -> dict[str, int] | None:
    """Project carry 0284's server_info.database_pool onto closed integer counters."""
    if not isinstance(capabilities, dict):
        return None
    info = capabilities.get("server_info")
    stats = info.get("database_pool") if isinstance(info, dict) else None
    if not isinstance(stats, dict):
        return None
    projected: dict[str, int] = {}
    for source, target in POOL_FIELDS.items():
        value = stats.get(source)
        if type(value) is not int or not 0 <= value <= MAX_HOME_SIGNAL_INTEGER:
            return None
        projected[target] = value
    wait_ns = stats.get("wait_duration_ns")
    if type(wait_ns) is not int or not 0 <= wait_ns <= MAX_HOME_SIGNAL_INTEGER:
        return None
    projected["wait_ms"] = wait_ns // 1_000_000
    return projected


def read_database_pool(management_key: str) -> dict[str, int] | None:
    status, body = request_json(
        f"{HOME_URL}/v8/management/capabilities", "GET", management_key, timeout=1
    )
    return database_pool(body) if status == 200 else None


def database_pool_line(counters: dict[str, int]) -> str:
    return DATABASE_POOL_MARKER + json.dumps(counters, sort_keys=True, separators=(",", ":"))


class DatabasePoolPoll:
    """Reads Home's pool counters every 15 s on its own thread; logged when waits change or every 5 min.

    The pinned Home answers this read only after one database query of its own, so the counters go
    stale while the pool is saturated. Slow-statement counts still show such an episode.
    """

    INTERVAL_SECONDS = 15.0
    QUIET_REPORT_SECONDS = 300.0

    def __init__(
        self,
        readiness: Any,
        management_key: str,
        read: Callable[[str], dict[str, int] | None] | None = None,
    ) -> None:
        self._readiness = readiness
        self._management_key = management_key
        self._read = read
        self._reported_wait_count: int | None = None
        self._reported_at = -math.inf

    def run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            self.check_once(time.monotonic())
            stop.wait(self.INTERVAL_SECONDS)

    def check_once(self, now: float) -> None:
        counters = (
            self._read(self._management_key)
            if self._read is not None
            else read_database_pool(self._management_key)
        )
        if counters is None:
            return
        self._readiness.set_database_pool(counters)
        if (
            counters["wait_count"] != self._reported_wait_count
            or now - self._reported_at >= self.QUIET_REPORT_SECONDS
        ):
            self._reported_wait_count = counters["wait_count"]
            self._reported_at = now
            emit(database_pool_line(counters))
