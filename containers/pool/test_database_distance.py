from __future__ import annotations

import unittest
from unittest.mock import patch

from . import pool_contract
from .readiness import Readiness


class ReadinessDistanceTests(unittest.TestCase):
    def test_distance_is_pending_until_measured_then_closed_values(self) -> None:
        readiness = Readiness("k" * 32)
        self.assertEqual(readiness.snapshot()[1]["db_rtt_state"], "pending")
        self.assertNotIn("db_rtt_ms", readiness.snapshot()[1])
        readiness.set_database_distance(5)
        body = readiness.snapshot()[1]
        self.assertEqual((body["db_rtt_state"], body["db_rtt_ms"]), ("measured", 5))
        readiness.set_database_distance(None)
        body = readiness.snapshot()[1]
        self.assertEqual(body["db_rtt_state"], "failed")
        self.assertNotIn("db_rtt_ms", body)

    def test_location_is_reported_only_in_its_closed_form(self) -> None:
        for value, expected in [("fra07", "fra07"), ("LIS01", "lis01"), ("frankfurt", None), ("", None)]:
            with patch.dict("os.environ", {"CLOUDFLARE_LOCATION": value}):
                self.assertEqual(Readiness("k" * 32).snapshot()[1].get("location"), expected, value)


class HomeDatabaseDistanceTests(unittest.TestCase):
    def test_only_a_closed_whole_millisecond_answer_counts(self) -> None:
        cases = [
            ((200, {"rtt_ms": 5, "samples": 7}), 5),
            ((200, {"rtt_ms": 0}), None),
            ((200, {"rtt_ms": 3501}), None),
            ((200, {"rtt_ms": 4.5}), None),
            ((200, {"rtt_ms": True}), None),
            ((503, {"error": "distance_unavailable"}), None),
        ]
        for answer, expected in cases:
            with patch.object(pool_contract, "request_json", return_value=answer):
                self.assertEqual(pool_contract.home_database_distance("key"), expected, answer)

    def test_a_failed_read_never_raises(self) -> None:
        with patch.object(pool_contract, "request_json", side_effect=OSError("refused")):
            self.assertIsNone(pool_contract.home_database_distance("key"))


if __name__ == "__main__":
    unittest.main()
