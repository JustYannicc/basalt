"""Lifetime-limited replacement of a failed, previously healthy Home generation."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager

from .pool_contract import StartupError
from .recovery_deadline import RecoveryCancelled, RecoveryDeadline, recovery_deadline
from .recovery_signals import report_recovery

RECOVERY_DELAYS = (1, 5)


class HomeExited(StartupError):
    def __init__(self, exit_code: int) -> None:
        super().__init__("Home exited")
        self.exit_code = exit_code


class RecoveryEpisode:
    def __init__(self, budget: HomeRecovery, deadline: RecoveryDeadline) -> None:
        self.budget = budget
        self.deadline = deadline

    def before_launch(self) -> None:
        self.deadline.remaining()
        if self.budget.launches >= len(RECOVERY_DELAYS):
            raise StartupError("Home recovery launch budget exhausted")
        delay = RECOVERY_DELAYS[self.budget.launches]
        self.deadline.wait(delay)
        self.budget.launches += 1
        report_recovery(
            "attempt", self.budget.launches, delay, self.deadline.elapsed_ms()
        )

    def recovered(self) -> None:
        self.deadline.remaining()
        report_recovery(
            "recovered", self.budget.launches, 0, self.deadline.elapsed_ms()
        )


class HomeRecovery:
    def __init__(self) -> None:
        self.launches = 0

    @contextmanager
    def episode(
        self,
        stop: threading.Event,
        clock: Callable[[], float] | None = None,
        started_at: float | None = None,
    ) -> Iterator[RecoveryEpisode]:
        deadline = RecoveryDeadline(stop, clock or time.monotonic, started_at)
        try:
            with recovery_deadline(deadline):
                yield RecoveryEpisode(self, deadline)
        except RecoveryCancelled:
            raise
        except Exception:
            report_recovery("exhausted", self.launches, 0, deadline.elapsed_ms())
            raise
