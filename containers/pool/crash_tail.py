"""Keep only bounded Home error records after secret removal."""

from __future__ import annotations

import base64
import re
import threading
from collections import deque
from collections.abc import Mapping
from urllib.parse import unquote, urlsplit

from .child_signals import HOME_LOG_LINE


MAX_TAIL_LINES = 8
MAX_LINE_BYTES = 512
MAX_INPUT_CHARS = 8192
REDACTED = "[redacted]"
SECRET_NAME = re.compile(r"key|token|secret|password|passwd|credential|dsn|url|auth|cookie", re.I)
URI = re.compile(r"[a-z][a-z0-9+.-]*://[^\s<>\"']+", re.I)
HEADER = re.compile(r"\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=].*", re.I)
AUTH = re.compile(r"\b(?:Bearer|Basic)\s+[^\s,;]+", re.I)
OPAQUE = re.compile(r"[a-zA-Z0-9_+/.=-]{24,}")
EMAIL = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9.-]+")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
STRUCTURED_OR_QUOTED = re.compile(r"[{}\[\]\"'`\\]")
ASSIGNMENT = re.compile(r"(?:^|\s)[a-zA-Z_][a-zA-Z0-9_.-]*\s*=")
ERROR_LEVELS = frozenset(("error", "fatal", "panic"))


def percent_decoded(value: str) -> str | None:
    # Bound recursive encoding and refuse ambiguous or malformed leftovers.
    for _ in range(3):
        if "%" not in value:
            return value
        try:
            decoded = unquote(value, errors="strict")
        except UnicodeError:
            return None
        if decoded == value:
            return None
        value = decoded
    return value if "%" not in value else None


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
        variants = set(secrets)
        for value in secrets:
            decoded = percent_decoded(value)
            if decoded:
                variants.add(decoded)
            for encode in (base64.b64encode, base64.urlsafe_b64encode):
                encoded = encode(value.encode("utf-8")).decode("ascii")
                variants.update((encoded, encoded.rstrip("=")))
        self._secrets = sorted((value for value in variants if value), key=len, reverse=True)
        self._lines: deque[str] = deque(maxlen=MAX_TAIL_LINES)
        self._lock = threading.Lock()
        self._private_key = False

    def append(self, line: str) -> None:
        with self._lock:
            if "-----BEGIN " in line:
                self._private_key = True
                return
            if self._private_key:
                if "-----END " in line:
                    self._private_key = False
                return
            if len(line) >= MAX_INPUT_CHARS:
                return
            match = HOME_LOG_LINE.fullmatch(ANSI.sub("", line).strip())
            if match is None or match["level"] not in ERROR_LEVELS:
                return
            message = percent_decoded(match["message"])
            if message is None or STRUCTURED_OR_QUOTED.search(message):
                return
            if any(not char.isprintable() or (not char.isascii() and not char.isalnum()) for char in message):
                return
            for secret in self._secrets:
                message = message.replace(secret, REDACTED)
            # Unknown fields are rejected as a whole, never guessed by their names.
            if ASSIGNMENT.search(message):
                return
            safe = HEADER.sub(REDACTED, message)
            safe = AUTH.sub(REDACTED, safe)
            safe = URI.sub(REDACTED, safe)
            safe = EMAIL.sub(REDACTED, safe)
            safe = OPAQUE.sub(REDACTED, safe).strip()
            if safe:
                record = match["level"] + ": " + safe
                self._lines.append(record.encode("utf-8")[:MAX_LINE_BYTES].decode("utf-8", errors="ignore"))

    def snapshot(self) -> list[str]:
        with self._lock:
            return list(self._lines)
