"""Retain fixed Home error templates and one bounded diagnostic class."""

from __future__ import annotations

import re
import threading
from collections import deque

from .child_signals import HOME_LOG_LINE


MAX_TAIL_LINES = 8
MAX_LINE_BYTES = 512
MAX_INPUT_CHARS = 8192
LEVEL_PREFIXES = {"error": "error: ", "fatal": "fatal: ", "panic": "panic: "}

# Exact log.Errorf templates in cmd/home/main.go at Home eca75d6.
ERROR_TEMPLATES = (
    "only one of -import, -export, -db-import, or -db-export can be used",
    "failed to validate database snapshot: %v",
    "failed to load cluster config: %v",
    "failed to validate database snapshot for target backend: %v",
    "failed to open database: %v",
    "failed to get sql db: %v",
    "failed to import database snapshot: %v",
    "failed to migrate database: %v",
    "failed to export database snapshot: %v",
    "failed to initialize lifecycle configuration: %v",
    "failed to import local state: %v",
    "failed to export local state: %v",
    "failed to load database config snapshot: %v",
    "database config is empty; run with -import first",
    "failed to load database runtime config: %v",
    "failed to init runtime: %v",
    "failed to init runtime",
    "failed to resolve database node ip: %v",
    "failed to init runtime certificates: %v",
    "failed to resolve listen address: %v",
    "failed to resolve cluster advertised port: %v",
    "failed to resolve database node port: listen port must be greater than 0",
    "failed to init cluster runtime adapter",
    "failed to start runtime: %v",
    "failed to apply in-flight observation config: %v",
    "failed to init management http: %v",
    "failed to initialize cluster coordinator: %v",
    "failed to listen on %s: %v",
    "failed to start HTTPS server: tls.cert or tls.key is empty",
    "failed to start HTTPS server: %v",
    "http server error: %v",
    "listener accept error: %v",
    "cluster coordinator error: %v",
    "cluster event watcher error: %v",
)

# First match wins. Error text can choose one of these labels, never input text.
ERROR_CLASSES = (
    ("fenced_or_retired", ("fenced", "retired", "home incarnation is not active", "home incarnation not found")),
    ("context_canceled", ("context canceled", "context cancelled")),
    ("deadline_exceeded", ("deadline exceeded", "i/o timeout", "timed out")),
    ("conn_refused", ("connection refused",)),
    ("eof", ("eof",)),
    ("tls", ("tls", "x509", "certificate")),
    ("dns", ("no such host", "name resolution", "server misbehaving")),
    ("permission_denied", ("permission denied", "operation not permitted")),
    ("no_such_file", ("no such file or directory", "file does not exist")),
    ("sql", ("sqlstate", "sql:", "pq:", "postgres", "database is locked", "database is closed")),
)

# A formatted template wins if a fixed record also fits its dynamic slot.
TEMPLATE_PATTERNS = tuple(
    (template, re.compile(re.escape(template).replace("%v", "(?P<error>.*)").replace("%s", ".*")))
    for template in sorted(ERROR_TEMPLATES, key=lambda value: "%v" not in value)
)


def classify_error(value: str) -> str:
    folded = value.casefold()
    for label, needles in ERROR_CLASSES:
        if any(needle in folded for needle in needles):
            return label
    return "other"


def project_error(message: str, prefix: str) -> str:
    for template, pattern in TEMPLATE_PATTERNS:
        match = pattern.fullmatch(message)
        if match is None:
            continue
        label = classify_error(match["error"]) if "%v" in template else "other"
        # The listen-address %s is always constant; only the error class varies.
        return prefix + template.replace("%s", "redacted").replace("%v", label)
    return prefix + "unrecognized"


class HomeCrashTail:
    def __init__(self) -> None:
        self._lines: deque[str] = deque(maxlen=MAX_TAIL_LINES)
        self._lock = threading.Lock()

    def append(self, line: str) -> None:
        if len(line) >= MAX_INPUT_CHARS:
            return
        match = HOME_LOG_LINE.fullmatch(line.strip())
        if match is None:
            return
        prefix = LEVEL_PREFIXES.get(match["level"])
        if prefix is None:
            return
        record = project_error(match["message"], prefix)
        with self._lock:
            self._lines.append(record)

    def snapshot(self) -> list[str]:
        with self._lock:
            return list(self._lines)
