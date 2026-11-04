"""Deterministic supervisor recovery and generation-fencing regressions."""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr
from unittest.mock import Mock

from .pool_contract import StartupError
from .recovery import HomeExited, HomeRecovery
from .recovery_deadline import (
    RecoveryCancelled,
    RecoveryTimeout,
    operation_timeout,
)
from .recovery_signals import report_recovery


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


class Stop:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.stopped = False
        self.waits: list[float] = []
        self.on_wait = None

    def is_set(self) -> bool:
        return self.stopped

    def set(self) -> None:
        self.stopped = True

    def wait(self, seconds: float = 0) -> bool:
        self.waits.append(seconds)
        self.clock.now += seconds
        if self.on_wait is not None:
            self.on_wait(seconds)
        return self.stopped


def recover(budget, stop, invalidate, terminate, launch, clock):
    with budget.episode(stop, clock) as episode:
        invalidate()
        while True:
            terminate()
            episode.before_launch()
            try:
                launch()
            except HomeExited as error:
                if error.exit_code != 1:
                    raise
                invalidate()
                continue
            episode.recovered()
            return


class RecoveryTests(unittest.TestCase):
    def test_two_launches_across_successful_episodes_never_reset_budget(self) -> None:
        clock = Clock()
        stop = Stop(clock)
        recovery = HomeRecovery()
        launch = Mock()
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            recover(recovery, stop, Mock(), Mock(), launch, clock)
            clock.now += 3600
            recover(recovery, stop, Mock(), Mock(), launch, clock)
            with self.assertRaises(StartupError):
                recover(recovery, stop, Mock(), Mock(), launch, clock)
        self.assertEqual(launch.call_count, 2)
        self.assertEqual(stop.waits, [1, 5])
        records = [
            json.loads(line.split(" ", 1)[1]) for line in stderr.getvalue().splitlines()
        ]
        self.assertEqual(
            [r["state"] for r in records],
            ["attempt", "recovered", "attempt", "recovered", "exhausted"],
        )

    def test_replacement_home_code_one_consumes_remaining_attempt(self) -> None:
        clock = Clock()
        launch = Mock(side_effect=[HomeExited(1), None])
        with redirect_stderr(io.StringIO()):
            recover(HomeRecovery(), Stop(clock), Mock(), Mock(), launch, clock)
        self.assertEqual(launch.call_count, 2)

    def test_non_one_exit_and_other_startup_failures_are_terminal(self) -> None:
        for error in (HomeExited(-9), HomeExited(0), StartupError("bad config")):
            clock = Clock()
            launch = Mock(side_effect=error)
            with redirect_stderr(io.StringIO()), self.assertRaises(type(error)):
                recover(HomeRecovery(), Stop(clock), Mock(), Mock(), launch, clock)
            self.assertEqual(launch.call_count, 1)

    def test_one_deadline_includes_teardown_backoff_and_every_phase(self) -> None:
        clock = Clock()
        stop = Stop(clock)
        timeouts = []

        def teardown() -> None:
            clock.now += 20
            timeouts.append(operation_timeout(180))

        def launch() -> None:
            for phase in range(3):
                timeouts.append(operation_timeout(180))
                clock.now += 60
            operation_timeout(180)

        with redirect_stderr(io.StringIO()), self.assertRaises(RecoveryTimeout):
            recover(HomeRecovery(), stop, Mock(), teardown, launch, clock)
        self.assertEqual(timeouts, [157, 156, 96, 36])
        self.assertEqual(stop.waits, [1])

    def test_deadline_expiring_in_teardown_prevents_launch(self) -> None:
        clock = Clock()
        launch = Mock()

        def teardown() -> None:
            clock.now = 180

        with redirect_stderr(io.StringIO()), self.assertRaises(RecoveryTimeout):
            recover(HomeRecovery(), Stop(clock), Mock(), teardown, launch, clock)
        launch.assert_not_called()

    def test_shutdown_during_backoff_cancels_without_exhaustion_or_launch(self) -> None:
        clock = Clock()
        stop = Stop(clock)
        stop.on_wait = lambda _: stop.set()
        launch = Mock()
        stderr = io.StringIO()
        with redirect_stderr(stderr), self.assertRaises(RecoveryCancelled):
            recover(HomeRecovery(), stop, Mock(), Mock(), launch, clock)
        launch.assert_not_called()
        self.assertEqual(stderr.getvalue(), "")

    def test_receipts_are_closed_and_reject_invalid_fields(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr):
            report_recovery("attempt", 1, 1, 0)
            report_recovery("private-token", 1, 1, 0)
            report_recovery("attempt", True, 1, 0)
            report_recovery("attempt", 3, 1, 0)
            report_recovery("attempt", 1, 1, 180001)
        self.assertEqual(
            stderr.getvalue(),
            'POOL_HOME_RECOVERY {"state":"attempt","attempt":1,"delay_seconds":1,"elapsed_ms":0}\n',
        )
