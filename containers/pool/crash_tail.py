"""Redact before retaining a bounded tail of otherwise discarded Home output."""

from __future__ import annotations

import json
import re
import threading
from collections import deque
from collections.abc import Mapping
from urllib.parse import quote, unquote, urlsplit


MAX_TAIL_LINES = 8
MAX_LINE_BYTES = 512
MAX_INPUT_CHARS = 8192
REDACTED = "[redacted]"
SECRET_NAME = re.compile(r"key|token|secret|password|passwd|credential|dsn|url", re.I)
URI = re.compile(r"[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)
HEADER = re.compile(r"\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*", re.I)
AUTH = re.compile(r"\b(?:Bearer|Basic)\s+[^\s,;]+", re.I)
FIELD = re.compile(
    r"(?P<key>[\"']?[a-z0-9_-]{0,64}(?:token|password|passwd|secret|credential|key)"
    r"[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)", re.I,
)
OPAQUE = re.compile(r"[a-zA-Z0-9_+/.=-]{24,}")
EMAIL = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


class HomeCrashTail:
    def __init__(self, environment: Mapping[str, str]) -> None:
        secrets = set()
        for name, value in environment.items():
            if value and SECRET_NAME.search(name):
                secrets.update(part for part in (value, value.strip(), *value.splitlines()) if part)
                try:
                    uri = urlsplit(value)
                    secrets.update(unquote(part) for part in (uri.username, uri.password) if part)
                except ValueError:
                    pass
        self._secrets = sorted(
            {encoded for value in secrets for encoded in (value, quote(value, safe=""), json.dumps(value)[1:-1])},
            key=len, reverse=True,
        )
        self._lines: deque[str] = deque(maxlen=MAX_TAIL_LINES)
        self._lock = threading.Lock()
        self._private_key = False

    def append(self, line: str) -> None:
        with self._lock:
            if "-----BEGIN " in line:
                self._private_key = True
                self._lines.append("[private key omitted]")
                return
            if self._private_key:
                if "-----END " in line:
                    self._private_key = False
                return
            if len(line) >= MAX_INPUT_CHARS:
                self._lines.append("[oversized line omitted]")
                return
            safe = ANSI.sub("", line)
            for secret in self._secrets:
                safe = safe.replace(secret, REDACTED)
            safe = HEADER.sub(REDACTED, safe)
            safe = AUTH.sub(REDACTED, safe)
            safe = URI.sub(REDACTED, safe)
            safe = FIELD.sub(lambda match: match["key"] + REDACTED, safe)
            safe = EMAIL.sub(REDACTED, safe)
            safe = OPAQUE.sub(REDACTED, safe)
            safe = "".join(char if char.isprintable() else " " for char in safe).strip()
            if safe:
                self._lines.append(safe.encode("utf-8")[:MAX_LINE_BYTES].decode("utf-8", errors="ignore"))

    def snapshot(self) -> list[str]:
        with self._lock:
            return list(self._lines)
