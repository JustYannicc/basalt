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
