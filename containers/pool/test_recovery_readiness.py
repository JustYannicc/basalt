"""Late policy observations cannot authorize a replacement generation."""

import unittest
from unittest.mock import patch

from . import policy_monitor
from .readiness import Readiness


class GenerationTests(unittest.TestCase):
    def test_late_old_probe_response_cannot_regrant_lease(self) -> None:
        ready = Readiness("fixture")
        ready.set_ready(True)
        ready.refresh_policy_lease("a" * 32)
        previous = ready.generation()
        nonce = "n" * 32

        def late_response(*args):
            ready.home_process_restarted()
            ready.enable_policy_observations()
            ready.set_ready(True)
            ready.note_policy_probe(nonce, previous)
            return "healthy", "a" * 32

        with patch.object(
            policy_monitor, "probe_home_policy", side_effect=late_response
        ):
            self.assertEqual(
                policy_monitor.PolicyHealthMonitor(ready, "fixture").check_once(),
                "unavailable",
            )
        self.assertNotEqual(ready.generation(), previous)
        self.assertFalse(ready.wait_for_policy_probe(nonce, 0, previous))
        self.assertFalse(ready.snapshot()[0])
        self.assertEqual(ready.readiness_response()[2], 0)
        self.assertTrue(ready.refresh_policy_lease("b" * 32, ready.generation()))
        self.assertTrue(ready.snapshot()[0])

    def test_monitor_does_not_probe_the_old_home_during_teardown(self) -> None:
        ready = Readiness("fixture")
        ready.home_process_restarted()
        with patch.object(policy_monitor, "probe_home_policy") as probe:
            self.assertEqual(
                policy_monitor.PolicyHealthMonitor(ready, "fixture").check_once(),
                "missed",
            )
        probe.assert_not_called()

    def test_old_unavailable_response_cannot_revoke_new_lease(self) -> None:
        ready = Readiness("fixture")

        def late_response(*args):
            ready.home_process_restarted()
            ready.enable_policy_observations()
            ready.set_ready(True)
            ready.refresh_policy_lease("b" * 32, ready.generation())
            return "unavailable", None

        with patch.object(
            policy_monitor, "probe_home_policy", side_effect=late_response
        ):
            policy_monitor.PolicyHealthMonitor(ready, "fixture").check_once()
        self.assertTrue(ready.snapshot()[0])
