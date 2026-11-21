"""Supervision of the resumable-stream front layer (#1642).

The layer exists to keep streams alive, so its own exit must never end the container: it restarts
alone, and readiness advertises resume only while it answers its health check. While it is down the
controller sends marked calls straight to the node, which is the behaviour before the layer existed.
"""

from __future__ import annotations

import time
from typing import Callable, Protocol

RESUME_BINARY = "/usr/local/bin/pool-resume"
FIRST_BACKOFF_SECONDS = 1.0
MAX_BACKOFF_SECONDS = 30.0
# A layer healthy this long earns a fresh backoff, so one old crash never slows a later restart.
STABLE_SECONDS = 60.0


class Process(Protocol):
    def poll(self) -> int | None: ...


class LayerChild(Protocol):
    name: str
    process: Process


class ResumeLayer:
    def __init__(
        self,
        spawn: Callable[[], LayerChild],
        healthy: Callable[[], bool],
        report_exit: Callable[[LayerChild, int], None],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._spawn = spawn
        self._healthy = healthy
        self._report_exit = report_exit
        self._clock = clock
        self._child: LayerChild | None = None
        self._backoff = FIRST_BACKOFF_SECONDS
        self._next_start = 0.0
        self._healthy_since: float | None = None

    @property
    def child(self) -> LayerChild | None:
        return self._child

    def tick(self) -> bool:
        """Advance supervision by one observation; return whether resume may be advertised."""
        now = self._clock()
        child = self._child
        if child is not None:
            exit_code = child.process.poll()
            if exit_code is not None:
                self._child = None
                self._healthy_since = None
                self._schedule_restart(now)
                self._report_exit(child, exit_code)
                return False
            if not self._probe():
                self._healthy_since = None
                return False
            if self._healthy_since is None:
                self._healthy_since = now
            elif now - self._healthy_since >= STABLE_SECONDS:
                self._backoff = FIRST_BACKOFF_SECONDS
            return True
        if now < self._next_start:
            return False
        try:
            self._child = self._spawn()
        except OSError:
            self._schedule_restart(now)
        return False

    def _probe(self) -> bool:
        try:
            return self._healthy()
        except Exception:
            return False

    def _schedule_restart(self, now: float) -> None:
        self._next_start = now + self._backoff
        self._backoff = min(self._backoff * 2, MAX_BACKOFF_SECONDS)
