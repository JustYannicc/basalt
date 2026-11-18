"""Closed slow-statement and connection-pool signals."""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock

from . import db_signals
from .child_signals import home_message
from .readiness import Readiness

SECRET = "private-sentinel-7f3a"
HOME_PREFIX = "[CLIProxyAPIHome] [2026-11-18 21:00:00] [--------] [warn ] "


def slow_line(elapsed: str, sql: str) -> str:
    return f"{HOME_PREFIX}SLOW SQL >= 200ms [{elapsed}ms] [rows:1] {sql}\n"


class SlowStatementTests(unittest.TestCase):
    def test_home_line_becomes_duration_and_fingerprint_only(self) -> None:
        line = slow_line(
            "523.441", f"SELECT * FROM \"kv_store\" WHERE key = '{SECRET}' AND id = 42 LIMIT 1"
        )
        elapsed, fingerprint = db_signals.slow_statement(home_message("home", line))
        self.assertEqual(elapsed, 524)
        signal = db_signals.slow_statement_line(elapsed, fingerprint)
        marker, payload = signal.split(" ", 1)
        self.assertEqual(marker, "POOL_HOME_SLOW_SQL")
        self.assertEqual(json.loads(payload), {"elapsed_ms": 524, "statement": fingerprint})
        self.assertRegex(fingerprint, r"^[a-f0-9]{16}$")
        self.assertNotIn(SECRET, signal)
        self.assertNotIn("kv_store", signal)

    def test_same_query_shape_shares_a_fingerprint(self) -> None:
        shapes = [
            "SELECT * FROM users WHERE id = 1 AND name = 'a'",
            "select *  from users where id = 977 and name = 'it''s'",
            "SELECT * FROM users WHERE id = $1 AND name = $2",
        ]
        fingerprints = {db_signals.statement_fingerprint(sql) for sql in shapes}
        self.assertEqual(len(fingerprints), 1)
        self.assertEqual(
            db_signals.statement_fingerprint("SELECT 1 FROM t WHERE id IN (1, 2, 3)"),
            db_signals.statement_fingerprint("SELECT 1 FROM t WHERE id IN (7)"),
        )
        self.assertNotEqual(
            db_signals.statement_fingerprint("SELECT * FROM users WHERE id = 1"),
            db_signals.statement_fingerprint("SELECT * FROM usage WHERE id = 1"),
        )

    def test_other_lines_are_not_slow_statements(self) -> None:
        for message in (
            None,
            "SLOW SQL >= 200ms [abc] [rows:1] SELECT 1",
            "failed to connect: SLOW SQL >= 200ms [1ms] [rows:1] SELECT 1",
            f"{SECRET}",
        ):
            with self.subTest(message=message):
                self.assertIsNone(db_signals.slow_statement(message))
        self.assertIsNone(
            db_signals.slow_statement(home_message("node", slow_line("300", "SELECT 1")))
        )


class DatabasePoolTests(unittest.TestCase):
    def capabilities(self, **overrides) -> dict:
        stats = {
            "max_open_connections": 6,
            "open_connections": 6,
            "in_use": 6,
            "idle": 0,
            "wait_count": 41,
            "wait_duration_ns": 3_400_123_456,
            "max_idle_closed": 0,
            **overrides,
        }
        return {"server_info": {"database_pool": stats, "home_version": "v1.1.6"}}

    def test_projects_closed_integer_counters(self) -> None:
        self.assertEqual(
            db_signals.database_pool(self.capabilities()),
            {"max_open": 6, "open": 6, "in_use": 6, "idle": 0, "wait_count": 41, "wait_ms": 3400},
        )

    def test_rejects_missing_or_malformed_counters(self) -> None:
        for value in ({}, None, [], {"server_info": {}}, {"server_info": {"database_pool": None}}):
            with self.subTest(value=value):
                self.assertIsNone(db_signals.database_pool(value))
        for field, bad in (("in_use", -1), ("idle", True), ("wait_count", "41"), ("wait_duration_ns", 1.5)):
            with self.subTest(field=field):
                self.assertIsNone(db_signals.database_pool(self.capabilities(**{field: bad})))

    def test_read_uses_a_short_management_get(self) -> None:
        request = Mock(return_value=(200, self.capabilities()))
        self.assertEqual(db_signals.read_database_pool("key", request)["wait_count"], 41)
        url, method, key = request.call_args.args
        self.assertTrue(url.endswith("/v8/management/capabilities"))
        self.assertEqual((method, key, request.call_args.kwargs), ("GET", "key", {"timeout": 1}))
        request.return_value = (0, {})
        self.assertIsNone(db_signals.read_database_pool("key", request))

    def test_poll_cadence_and_logging(self) -> None:
        counters = {"max_open": 6, "open": 6, "in_use": 2, "idle": 4, "wait_count": 0, "wait_ms": 0}
        reads = [dict(counters), dict(counters), {**counters, "wait_count": 3, "wait_ms": 900}]
        sink = Mock()
        poll = db_signals.DatabasePoolPoll("key", sink, read=lambda _key: reads.pop(0))
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            poll.maybe_poll(0)
            poll.maybe_poll(10)  # inside the interval: no read
            poll.maybe_poll(15)  # unchanged waits: quiet
            poll.maybe_poll(30)  # waits rose: logged
        self.assertEqual(sink.set_database_pool.call_count, 3)
        lines = stdout.getvalue().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[1].split(" ", 1)[1])["wait_count"], 3)


class ReadinessDiagnosticsTests(unittest.TestCase):
    def test_absent_until_observed(self) -> None:
        readiness = Readiness("fixture-management-key")
        _, payload = readiness.snapshot()
        self.assertFalse({"db_slow_count", "db_slow_max_ms", "db_pool"} & set(payload))
        readiness.note_slow_statement(250)
        readiness.note_slow_statement(1200)
        readiness.set_database_pool({"max_open": 6, "open": 6, "in_use": 6, "idle": 0, "wait_count": 9, "wait_ms": 4100})
        _, payload = readiness.snapshot()
        self.assertEqual(payload["db_slow_count"], 2)
        self.assertEqual(payload["db_slow_max_ms"], 1200)
        self.assertEqual(payload["db_pool"]["wait_ms"], 4100)


if __name__ == "__main__":
    unittest.main()
