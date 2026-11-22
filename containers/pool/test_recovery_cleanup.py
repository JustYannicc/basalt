"""Terminal recovery cleanup retains its absolute deadline and kills owned children."""

import io
import subprocess
import unittest
from contextlib import redirect_stderr
from types import SimpleNamespace
from unittest.mock import patch

from . import supervisor
from .pool_contract import StartupError
from .recovery import HomeRecovery
from .recovery_deadline import current_deadline
from .test_recovery import Clock, Stop


class CleanupTests(unittest.TestCase):
    def test_exhaustion_cleanup_kills_all_children_inside_original_deadline(self):
        clock = Clock()
        stop = Stop(clock)
        observed = []
        killed = []
        children = []
        for name in ("home", "node"):
            state = {"killed": False}

            def wait(timeout, state=state, name=name):
                observed.append((name, timeout, current_deadline().until))
                if not state["killed"]:
                    clock.now += timeout
                    raise subprocess.TimeoutExpired(name, timeout)
                return -9

            def kill(state=state, name=name):
                state["killed"] = True
                killed.append(name)

            children.append(
                SimpleNamespace(
                    process=SimpleNamespace(
                        poll=lambda state=state: -9 if state["killed"] else None,
                        terminate=lambda: None,
                        kill=kill,
                        wait=wait,
                    )
                )
            )
        budget = HomeRecovery()
        with (
            patch.object(supervisor.time, "monotonic", clock),
            redirect_stderr(io.StringIO()),
            self.assertRaises(StartupError),
            budget.episode(stop, clock) as episode,
        ):
            try:
                clock.now = 177
                raise StartupError("persistent failure")
            finally:
                stop.set()
                supervisor.terminate_children(children)
                self.assertIs(current_deadline(), episode.deadline)
        self.assertEqual(killed, ["home", "node"])
        self.assertLessEqual(clock.now, 180)
        self.assertTrue(all(until == 180 for _, _, until in observed))
        self.assertIsNone(current_deadline())


class OrdinaryStopTests(unittest.TestCase):
    """A stop outside any recovery episode, as a deploy's SIGTERM arrives on a quiet pool."""

    def test_children_that_ignore_sigterm_are_killed_at_fifteen_seconds(self):
        clock = Clock()
        waits = []
        killed = []
        terminated = []
        children = []
        for name in ("home", "node"):
            state = {"killed": False}

            def wait(timeout, state=state, name=name):
                waits.append((name, clock.now, timeout))
                # Each child takes its whole allowance, before and after the kill.
                clock.now += timeout
                if not state["killed"]:
                    raise subprocess.TimeoutExpired(name, timeout)
                return -9

            def kill(state=state, name=name):
                state["killed"] = True
                killed.append((name, clock.now))

            children.append(
                SimpleNamespace(
                    process=SimpleNamespace(
                        poll=lambda state=state: -9 if state["killed"] else None,
                        terminate=lambda name=name: terminated.append((name, clock.now)),
                        kill=kill,
                        wait=wait,
                    )
                )
            )
        with patch.object(supervisor, "time", SimpleNamespace(monotonic=clock)):
            supervisor.terminate_children(children)
        self.assertIsNone(current_deadline())
        self.assertEqual(terminated, [("home", 0.0), ("node", 0.0)], "both children get SIGTERM first")
        self.assertEqual(waits[:2], [("home", 0.0, 15.0), ("node", 15.0, 0)])
        self.assertEqual(killed, [("home", 15.0), ("node", 15.0)])
        self.assertEqual([timeout for _, _, timeout in waits[2:]], [1, 1])
        # One second for each killed child, one after the other: 17 s for two, inside the
        # controller's 30 s forced stop.
        self.assertEqual(clock.now, 17.0)
