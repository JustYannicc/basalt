"""Closed slow-statement and connection-pool signals."""

from __future__ import annotations

import io
import json
import pathlib
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

from . import db_signals, supervisor
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

    def test_truncated_multi_row_write_keeps_the_fingerprint_of_the_whole_write(self) -> None:
        rows = ",".join(["($%d,$%d)" % (2 * i + 1, 2 * i + 2) for i in range(400)])
        whole = "INSERT INTO log (a,b) VALUES " + rows
        message = "SLOW SQL >= 200ms [900ms] [rows:400] " + whole
        cut = message[: len(message) // 2 + 3]
        self.assertEqual(
            db_signals.slow_statement(cut, truncated=True)[1],
            db_signals.slow_statement(message)[1],
        )

    def test_multi_row_writes_share_a_fingerprint_whatever_the_batch_size(self) -> None:
        self.assertEqual(
            db_signals.statement_fingerprint("INSERT INTO log (a,b) VALUES ($1,$2),($3,$4)"),
            db_signals.statement_fingerprint("INSERT INTO log (a,b) VALUES ($1,$2),($3,$4),($5,$6)"),
        )

    def test_child_reader_reports_slow_statements_including_oversized_lines(self) -> None:
        big = "INSERT INTO log (line) VALUES " + ",".join(["('" + SECRET + "')"] * 600)
        script = (
            "import sys\n"
            f"sys.stdout.write({slow_line('250.5', 'SELECT 1 FROM t WHERE a = ' + repr(SECRET))!r})\n"
            f"sys.stdout.write({slow_line('9000', big)!r})\n"
        )
        noted: list[int] = []
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as root, redirect_stdout(stdout):
            child = supervisor.Child(
                "home", [sys.executable, "-c", script], {}, pathlib.Path(root),
                on_slow_statement=noted.append,
            )
            child.process.wait(timeout=10)
            child._reader.join(timeout=10)
            child.process.stdout.close()
        self.assertEqual(noted, [251, 9000])
        lines = stdout.getvalue().splitlines()
        self.assertEqual([line.split(" ", 1)[0] for line in lines], ["POOL_HOME_SLOW_SQL"] * 2)
        self.assertNotIn(SECRET, stdout.getvalue())

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

    def test_read_returns_counters_only_from_a_successful_answer(self) -> None:
        with patch.object(db_signals, "request_json", return_value=(200, self.capabilities())):
            self.assertEqual(db_signals.read_database_pool("key")["wait_count"], 41)
        with patch.object(db_signals, "request_json", return_value=(0, {})):
            self.assertIsNone(db_signals.read_database_pool("key"))
        with patch.object(db_signals, "request_json", return_value=(503, self.capabilities())):
            self.assertIsNone(db_signals.read_database_pool("key"))

    def test_counters_above_the_closed_bound_are_refused(self) -> None:
        self.assertIsNone(db_signals.database_pool(self.capabilities(wait_count=1 << 63)))

    def test_logs_when_waits_change_and_every_five_minutes(self) -> None:
        counters = {"max_open": 6, "open": 6, "in_use": 2, "idle": 4, "wait_count": 0, "wait_ms": 0}
        reads = [dict(counters), dict(counters), {**counters, "wait_count": 3, "wait_ms": 900}, {**counters, "wait_count": 3, "wait_ms": 900}]
        readiness = Mock()
        poll = db_signals.DatabasePoolPoll(readiness, "key", read=lambda _key: reads.pop(0))
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            poll.check_once(0)    # first reading: logged
            poll.check_once(15)   # unchanged: quiet
            poll.check_once(30)   # waits rose: logged
            poll.check_once(330)  # unchanged for five minutes: logged again
        self.assertEqual(readiness.set_database_pool.call_count, 4)
        logged = [json.loads(line.split(" ", 1)[1])["wait_count"] for line in stdout.getvalue().splitlines()]
        self.assertEqual(logged, [0, 3, 3])

    def test_unreadable_counters_leave_the_last_reading(self) -> None:
        readiness = Mock()
        poll = db_signals.DatabasePoolPoll(readiness, "key", read=lambda _key: None)
        with redirect_stdout(io.StringIO()) as stdout:
            poll.check_once(0)
        readiness.set_database_pool.assert_not_called()
        self.assertEqual(stdout.getvalue(), "")


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
        readiness.home_process_restarted()
        _, payload = readiness.snapshot()
        self.assertNotIn("db_pool", payload)
        self.assertEqual(payload["db_slow_count"], 2)


if __name__ == "__main__":
    unittest.main()
