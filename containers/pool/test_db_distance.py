"""Database distance measurement, its readiness fields and the controller-requested hold."""

from __future__ import annotations

import io
import json
import pathlib
import socket
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import Mock, patch

from . import db_distance, supervisor
from .db_distance import Distance
from .readiness import Readiness

MS = 1_000_000


class FakeNetwork:
    """Each connect advances a fake monotonic clock by the next scripted duration."""

    def __init__(self, durations_ms: list[float | None]) -> None:
        self.now = 0
        self.durations = list(durations_ms)
        self.opened = 0

    def clock(self) -> int:
        return self.now

    def resolve(self, *_args, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("192.0.2.1", 6432))]

    def open_socket(self, _family: int) -> Mock:
        self.opened += 1
        connection = Mock()

        def connect(_address) -> None:
            duration = self.durations.pop(0)
            if duration is None:
                self.now += 500 * MS
                raise TimeoutError()
            self.now += int(duration * MS)

        connection.connect.side_effect = connect
        return connection

    def measure(self, hold_ms: int | None = None) -> Distance:
        return db_distance.measure(
            "pooler.invalid",
            6432,
            hold_ms,
            clock=self.clock,
            resolve=self.resolve,
            open_socket=self.open_socket,
        )


class MeasureTests(unittest.TestCase):
    def test_median_of_successful_samples_rounded_up(self) -> None:
        distance = FakeNetwork([5.2, 4.1, 44.0, 4.3, 6.0, 4.9, 5.1]).measure()
        self.assertEqual(distance, Distance("measured", 6, 44, 7))

    def test_far_draw_is_held_only_above_the_controller_bound(self) -> None:
        self.assertEqual(FakeNetwork([42.0] * 7).measure(20).state, "held")
        self.assertEqual(FakeNetwork([20.0] * 7).measure(20).state, "measured")
        self.assertEqual(FakeNetwork([42.0] * 7).measure(None).state, "measured")

    def test_too_few_samples_is_unknown_and_never_holds(self) -> None:
        distance = FakeNetwork([None, None, 50.0, None, 50.0, None, None]).measure(20)
        self.assertEqual(distance, Distance("failed", None, None, 2))

    def test_total_budget_stops_further_attempts(self) -> None:
        network = FakeNetwork([1200.0, 1200.0, 1200.0, 1.0, 1.0, 1.0, 1.0])
        distance = network.measure()
        self.assertEqual(network.opened, 3)
        self.assertEqual(distance.samples, 3)
        self.assertEqual(distance.rtt_ms, 1200)

    def test_dns_failure_is_unknown(self) -> None:
        network = FakeNetwork([])
        distance = db_distance.measure(
            "pooler.invalid",
            6432,
            20,
            clock=network.clock,
            resolve=Mock(side_effect=socket.gaierror()),
            open_socket=network.open_socket,
        )
        self.assertEqual(distance, Distance("failed", None, None, 0))
        self.assertEqual(network.opened, 0)

    def test_real_loopback_listener(self) -> None:
        with socket.create_server(("127.0.0.1", 0)) as server:
            port = server.getsockname()[1]
            url = f"postgresql://user:secret@127.0.0.1:{port}/basalt_pool?sslmode=verify-full"
            distance = db_distance.measure_database(url, {})
        self.assertEqual(distance.state, "measured")
        self.assertEqual(distance.samples, 7)
        self.assertGreaterEqual(distance.rtt_ms, 1)

    def test_pooler_endpoint_forms(self) -> None:
        self.assertEqual(
            db_distance.pooler_endpoint("postgresql://u:p@db.example.invalid:6432/x?sslmode=verify-full"),
            ("db.example.invalid", 6432),
        )
        self.assertEqual(db_distance.pooler_endpoint("postgresql://u:p@[2001:db8::1]:6432/x"), ("2001:db8::1", 6432))
        self.assertEqual(db_distance.pooler_endpoint("postgresql://u:p@db.example.invalid/x"), ("db.example.invalid", 5432))

    def test_hold_bound_comes_from_the_start_environment(self) -> None:
        with patch.object(db_distance, "measure", return_value=Distance("held", 42, 47, 7)) as measure:
            db_distance.measure_database("postgresql://u:p@db.example.invalid:6432/x", {db_distance.HOLD_ENV: "20"})
            db_distance.measure_database("postgresql://u:p@db.example.invalid:6432/x", {})
        self.assertEqual([call.args for call in measure.call_args_list],
                         [("db.example.invalid", 6432, 20), ("db.example.invalid", 6432, None)])

    def test_unparseable_url_is_unknown(self) -> None:
        self.assertEqual(
            db_distance.measure_database("not a url", {}), Distance("failed", None, None, 0)
        )


class EnvironmentTests(unittest.TestCase):
    def test_hold_bound_accepts_only_whole_milliseconds_in_range(self) -> None:
        for value, expected in (
            ("20", 20),
            ("3500", 3500),
            ("3501", None),
            ("0", None),
            ("020", None),
            ("20.5", None),
            ("", None),
        ):
            with self.subTest(value=value):
                self.assertEqual(db_distance.hold_bound({db_distance.HOLD_ENV: value}), expected)
        self.assertIsNone(db_distance.hold_bound({}))

    def test_location_is_a_closed_code(self) -> None:
        self.assertEqual(db_distance.location({"CLOUDFLARE_LOCATION": "fra07"}), "fra07")
        for value in ("FRA07", "fra7", "fra07 ", "frankfurt", ""):
            with self.subTest(value=value):
                self.assertIsNone(db_distance.location({"CLOUDFLARE_LOCATION": value}))


class ReadinessFieldTests(unittest.TestCase):
    def test_pending_until_measured_then_fixed_fields(self) -> None:
        readiness = Readiness("fixture-management-key", location="fra07")
        _, payload = readiness.snapshot()
        self.assertEqual(payload["db_rtt_state"], "pending")
        self.assertEqual(payload["location"], "fra07")
        self.assertNotIn("db_rtt_ms", payload)
        readiness.set_database_distance(Distance("measured", 6, 44, 7))
        _, payload = readiness.snapshot()
        self.assertEqual(
            {key: payload[key] for key in payload if key not in {"boot_id", "started_at"}},
            {
                "db_rtt_state": "measured",
                "db_rtt_samples": 7,
                "db_rtt_ms": 6,
                "db_rtt_max_ms": 44,
                "location": "fra07",
            },
        )

    def test_failed_measurement_reports_no_distance(self) -> None:
        readiness = Readiness("fixture-management-key")
        readiness.set_database_distance(Distance("failed", None, None, 2))
        _, payload = readiness.snapshot()
        self.assertEqual(payload["db_rtt_state"], "failed")
        self.assertEqual(payload["db_rtt_samples"], 2)
        self.assertNotIn("db_rtt_ms", payload)
        self.assertNotIn("location", payload)


class StopDuringMeasurementTests(unittest.TestCase):
    def test_stop_during_measurement_never_launches_home(self) -> None:
        stop = threading.Event()
        child = Mock()

        def measured(*_args) -> Distance:
            stop.set()
            return Distance("measured", 5, 6, 7)

        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(supervisor, "ROOT", pathlib.Path(root)),
            patch.object(supervisor, "env_required", return_value="postgresql://pooler.invalid:6432/db"),
            patch.object(supervisor, "require_tmpfs"),
            patch.object(supervisor, "start_ready_server", return_value=Mock()),
            patch.object(supervisor, "PolicyHealthMonitor"),
            patch.object(supervisor.db_distance, "measure_database", side_effect=measured),
            patch.object(supervisor, "Child", child),
            redirect_stdout(io.StringIO()),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(supervisor.main(stop), 0)
        child.assert_not_called()


class HeldStartTests(unittest.TestCase):
    def test_held_start_never_launches_home_and_exits_cleanly_when_stopped(self) -> None:
        stop = threading.Event()
        child = Mock()
        published: list[dict] = []

        def start_ready_server(ready: Readiness) -> Mock:
            def stop_once_held() -> None:
                while not stop.is_set():
                    _, payload = ready.snapshot()
                    if payload["db_rtt_state"] == "held":
                        published.append(payload)
                        stop.set()
                    stop.wait(0.01)

            threading.Thread(target=stop_once_held, daemon=True).start()
            return Mock()

        stdout = io.StringIO()
        with (
            tempfile.TemporaryDirectory() as root,
            patch.object(supervisor, "ROOT", pathlib.Path(root)),
            patch.object(supervisor, "env_required", return_value="postgresql://pooler.invalid:6432/db"),
            patch.object(supervisor, "require_tmpfs"),
            patch.object(supervisor, "start_ready_server", side_effect=start_ready_server),
            patch.object(supervisor, "PolicyHealthMonitor"),
            patch.object(
                supervisor.db_distance,
                "measure_database",
                return_value=Distance("held", 42, 47, 7),
            ),
            patch.object(supervisor, "Child", child),
            redirect_stdout(stdout),
            redirect_stderr(io.StringIO()),
        ):
            self.assertEqual(supervisor.main(stop), 0)
        child.assert_not_called()
        self.assertEqual(published[0]["db_rtt_ms"], 42)
        lines = [line for line in stdout.getvalue().splitlines() if line.startswith("POOL_DB_DISTANCE ")]
        self.assertEqual(len(lines), 1)
        self.assertEqual(
            json.loads(lines[0].split(" ", 1)[1]),
            {"state": "held", "rtt_ms": 42, "max_ms": 47, "samples": 7, "location": None},
        )


if __name__ == "__main__":
    unittest.main()
