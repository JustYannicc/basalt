"""One monotonic deadline shared by every operation in a recovery episode."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar

RECOVERY_SECONDS = 180


class RecoveryTimeout(Exception):
    """The entire replacement episode exceeded its budget."""


class RecoveryCancelled(Exception):
    """Supervisor shutdown cancels recovery without a failure receipt."""


class RecoveryDeadline:
    def __init__(
        self,
        stop: threading.Event,
        clock: Callable[[], float] = time.monotonic,
        started_at: float | None = None,
    ) -> None:
        self.stop = stop
        self.clock = clock
        self.started = clock() if started_at is None else started_at
        self.until = self.started + RECOVERY_SECONDS

    def remaining(self, maximum: float = RECOVERY_SECONDS) -> float:
        if self.stop.is_set():
            raise RecoveryCancelled()
        remaining = self.until - self.clock()
        if remaining <= 0:
            raise RecoveryTimeout("Home recovery deadline exhausted")
        return min(maximum, remaining)

    def wait(self, seconds: float) -> None:
        if self.stop.wait(self.remaining(seconds)):
            raise RecoveryCancelled()
        self.remaining()

    def elapsed_ms(self) -> int:
        return min(
            RECOVERY_SECONDS * 1000, max(0, int((self.clock() - self.started) * 1000))
        )


_deadline: ContextVar[RecoveryDeadline | None] = ContextVar(
    "pool_recovery_deadline", default=None
)


@contextmanager
def recovery_deadline(deadline: RecoveryDeadline) -> Iterator[None]:
    token = _deadline.set(deadline)
    try:
        yield
    finally:
        _deadline.reset(token)


def operation_timeout(maximum: float) -> float:
    deadline = _deadline.get()
    return maximum if deadline is None else deadline.remaining(maximum)


def current_deadline() -> RecoveryDeadline | None:
    return _deadline.get()
