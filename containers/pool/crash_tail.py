"""Project bounded Home error records onto a fixed diagnostic vocabulary."""

from __future__ import annotations

import threading
from collections import deque

from .child_signals import HOME_INIT_FAILURE_PREFIXES, HOME_LOG_LINE


MAX_TAIL_LINES = 8
MAX_LINE_BYTES = 512
MAX_INPUT_CHARS = 8192
LEVEL_PREFIXES = {"error": "error: ", "fatal": "fatal: ", "panic": "panic: "}
PUNCTUATION = ("", ":", ",", ";", ".")
UNKNOWN_TOKENS = {suffix: "<v>" + suffix for suffix in PUNCTUATION}

# A subset of literals at Home eca75d6: cmd/home/main.go and
# internal/cluster/{home_incarnation,coordinator,events,database_snapshot,management/auth}.go.
HOME_ERROR_PHRASES = (
    "http server error",
    "listener accept error",
    "cluster coordinator error",
    "cluster event watcher error",
    "Home incarnation is fenced",
    "Home incarnation is not active",
    "Home incarnation not found",
    "cluster election found no live nodes",
    "cluster coordinator is not initialized",
    "cluster event watcher repository is nil",
    "credential id cannot change",
    "credential provider cannot change",
    "decode database snapshot manifest",
)

# Go stdlib diagnostic literals: syscall/zerrors_linux_amd64.go,
# internal/poll/fd.go, io/io.go, context/context.go, encoding/json,
# crypto/{tls,x509} and net's operation names. No formatted values are included.
GO_ERROR_PHRASES = (
    "permission denied",
    "no such file or directory",
    "address already in use",
    "connection refused",
    "connection reset by peer",
    "broken pipe",
    "network is unreachable",
    "i/o timeout",
    "use of closed network connection",
    "context canceled",
    "context deadline exceeded",
    "EOF unexpected EOF",
    "invalid character looking for beginning of value",
    "unexpected end of JSON input",
    "json: cannot unmarshal into Go struct field of type",
    "x509: certificate signed by unknown authority",
    "x509: certificate has expired or is not yet valid",
    "x509: certificate is valid for not",
    "tls: handshake failure",
    "tls: bad certificate",
    "tls: internal error",
    "tls: first record does not look like a TLS handshake",
    "dial tcp udp unix connect read write open stat lstat mkdir rename remove listen accept lookup",
)

_words = frozenset(
    word.rstrip(":,;.")
    for phrase in (
        *HOME_ERROR_PHRASES,
        *GO_ERROR_PHRASES,
        *(phrase for phrases in HOME_INIT_FAILURE_PREFIXES.values() for phrase in phrases),
    )
    for word in phrase.split()
)
ERROR_TOKENS = {word + suffix: word + suffix for word in _words for suffix in PUNCTUATION}


def project_error(message: str, prefix: str) -> str | None:
    tokens = []
    size = len(prefix)
    known = False
    for token in message.split():
        approved = ERROR_TOKENS.get(token)
        safe = approved if approved is not None else UNKNOWN_TOKENS.get(token[-1], "<v>")
        if tokens and safe == tokens[-1] and safe.startswith("<v>"):
            continue
        next_size = size + len(safe) + bool(tokens)
        if next_size > MAX_LINE_BYTES:
            break
        tokens.append(safe)
        size = next_size
        known = known or approved is not None
    return prefix + " ".join(tokens) if known else None


class HomeCrashTail:
    def __init__(self) -> None:
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
            match = HOME_LOG_LINE.fullmatch(line.strip())
            if match is None:
                return
            prefix = LEVEL_PREFIXES.get(match["level"])
            if prefix is None:
                return
            record = project_error(match["message"], prefix)
            if record is not None:
                self._lines.append(record)

    def snapshot(self) -> list[str]:
        with self._lock:
            return list(self._lines)
