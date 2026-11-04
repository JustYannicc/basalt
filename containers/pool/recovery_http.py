"""Deadline-aware loopback management reads during a replacement episode."""

from __future__ import annotations

import http.client
import json
import socket
import threading
import time
from typing import Any
from urllib.parse import urlsplit

from .recovery_deadline import RecoveryDeadline


def request_with_deadline(
    url: str,
    method: str,
    body: bytes | None,
    headers: dict[str, str],
    timeout: float,
    deadline: RecoveryDeadline,
) -> tuple[int, dict[str, Any]]:
    target = urlsplit(url)
    # Recovery can only contact the same two local control endpoints as startup.
    if (
        target.scheme != "http"
        or target.hostname != "127.0.0.1"
        or target.port not in (8317, 8327)
    ):
        raise ValueError("recovery requires a loopback management endpoint")
    until = time.monotonic() + deadline.remaining(timeout)
    expired = threading.Event()

    def remaining() -> float:
        left = until - time.monotonic()
        if expired.is_set() or left <= 0:
            raise TimeoutError("management request timed out")
        return deadline.remaining(left)

    connection = http.client.HTTPConnection(
        "127.0.0.1", target.port, timeout=remaining()
    )
    timer = None
    try:
        connection.connect()
        sock = connection.sock
        if sock is None:
            return 0, {}

        def expire_socket() -> None:
            expired.set()
            # Socket timeouts alone do not bound a slow-drip HTTP header/body.
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        timer = threading.Timer(remaining(), expire_socket)
        timer.daemon = True
        timer.start()
        sock.settimeout(remaining())
        connection.request(
            method,
            target.path + ("?" + target.query if target.query else ""),
            body,
            headers,
        )
        sock.settimeout(remaining())
        response = connection.getresponse()
        chunks: list[bytes] = []
        while True:
            sock.settimeout(remaining())
            chunk = response.read1(64 << 10)
            remaining()
            if not chunk:
                break
            chunks.append(chunk)
        data = b"".join(chunks)
        payload = json.loads(data) if data else {}
        remaining()
        return response.status, payload
    except (OSError, ValueError, http.client.HTTPException):
        deadline.remaining()
        return 0, {}
    finally:
        if timer is not None:
            timer.cancel()
        connection.close()
