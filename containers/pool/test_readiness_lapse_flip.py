"""The /ready lapse, flip and stall records: only the last kept, bounded lines, closed fields."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from . import policy_monitor
from . import readiness as readiness_module
from .readiness import (
    FLIP_LINE,
    LAPSE_LINE,
    LAPSE_STEPS,
    POLICY_HEALTH_LEASE_NS,
    POLICY_PLUGIN_ID,
    Readiness,
)

INSTANCE = "a" * 32
TOKEN_SENTINEL = "private-token-sentinel"
MS = 1_000_000


class Clock:
    def __init__(self) -> None:
        self.now = 10_000 * MS

    def __call__(self) -> int:
        return self.now

    def advance(self, ms: int) -> None:
        self.now += ms * MS


class LapseFlipTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.lines: list[str] = []
        patcher = patch.object(readiness_module, "emit", lambda line, err=False: self.lines.append(line))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.readiness = Readiness("key", self.clock)

    def serve(self) -> None:
        """A healthy probe and a passing service audit: the runtime is ready."""
        self.readiness.note_probe_step("home_plugins")
        self.readiness.note_probe_step(None)
        self.assertTrue(self.readiness.refresh_policy_lease(INSTANCE))
        self.readiness.set_ready(True, audit_revision=self.readiness.service_audit_revision())

    def payload(self) -> dict[str, object]:
        return self.readiness.readiness_response()[1]

    def test_a_quiet_runtime_answers_as_older_images_do(self) -> None:
        self.assertEqual(set(self.payload()), {"boot_id", "started_at", "db_rtt_state", "refusal"})

    def test_ready_and_lapse_flip_with_the_prior_state_duration(self) -> None:
        self.clock.advance(4_000)
        self.serve()
        flip = self.payload()["last_flip"]
        self.assertEqual({k: flip[k] for k in ("to", "reason", "prior_ms")}, {"to": "ready", "reason": "restored", "prior_ms": 4_000})
        self.clock.advance(1_500)
        payload = self.payload()
        self.assertEqual(payload["refusal"], "policy_unproven")
        self.assertEqual(payload["flips"], 2)
        self.assertEqual(payload["last_flip"]["to"], "refusing")
        self.assertEqual(payload["last_flip"]["reason"], "policy_unproven")
        # The state lasted until the lease's own deadline, not until someone asked.
        self.assertEqual(payload["last_flip"]["prior_ms"], 1_500)
        self.assertEqual(payload["lapses"], 1)
        self.assertEqual(payload["last_lapse"]["step"], "no_probe")
        self.assertEqual(
            self.lines,
            [
                FLIP_LINE + '{"to":"ready","reason":"restored","prior_ms":4000}',
                LAPSE_LINE + '{"step":"no_probe","ms":1500}',
                FLIP_LINE + '{"to":"refusing","reason":"policy_unproven","prior_ms":1500}',
            ],
        )

    def test_a_lapse_names_the_slowest_step_of_the_probe_in_flight(self) -> None:
        self.serve()
        self.clock.advance(250)
        self.readiness.note_probe_step("home_plugins")
        self.clock.advance(40)
        self.readiness.note_probe_step("plugin_probe")
        self.clock.advance(1_300)
        lapse = self.payload()["last_lapse"]
        # Measured to the lease's deadline, not to the moment someone asked.
        self.assertEqual((lapse["step"], lapse["ms"]), ("plugin_probe", 1_210))

    def probe(self, *steps: tuple[str, int], missed: bool) -> None:
        for step, ms in steps:
            self.readiness.note_probe_step(step)
            self.clock.advance(ms)
        self.readiness.note_probe_step(None, missed=missed)

    def test_a_lapse_noticed_by_the_next_renewal_names_where_the_misses_stopped(self) -> None:
        self.serve()
        for _ in range(2):
            self.clock.advance(255)
            self.probe(("home_plugins", 3), ("plugin_probe", 2), ("probe_log", 245), missed=True)
        self.clock.advance(1_000)
        self.probe(("home_plugins", 2), ("plugin_probe", 1), ("probe_log", 2), missed=False)
        # The healthy probe's renewal is what notices the lease ran out.
        self.assertTrue(self.readiness.refresh_policy_lease(INSTANCE))
        lapse = self.payload()["last_lapse"]
        self.assertEqual((lapse["step"], lapse["ms"]), ("probe_log", 245))

    def test_a_fast_failure_is_named_over_a_slower_step_before_it(self) -> None:
        self.serve()
        self.clock.advance(250)
        self.probe(("home_plugins", 200), ("plugin_probe", 3), missed=True)
        self.clock.advance(1_200)
        lapse = self.payload()["last_lapse"]
        self.assertEqual((lapse["step"], lapse["ms"]), ("plugin_probe", 3))

    def test_a_lapse_noticed_late_keeps_its_order_and_deadline(self) -> None:
        self.serve()
        revision = self.readiness.service_audit_revision()
        self.clock.advance(3_300)
        # A health check that blocked past the deadline reports back before anyone asked /ready.
        self.readiness.set_ready(True, audit_revision=revision)
        flips = [line for line in self.lines if line.startswith((LAPSE_LINE, FLIP_LINE))]
        self.assertEqual(flips[-2:], [
            LAPSE_LINE + '{"step":"no_probe","ms":1500}',
            FLIP_LINE + '{"to":"refusing","reason":"policy_unproven","prior_ms":1500}',
        ])

    def test_an_unnoticed_lapse_is_not_lost_to_an_invalidation(self) -> None:
        self.serve()
        self.clock.advance(1_600)
        self.readiness.invalidate_policy()
        self.assertEqual(self.payload()["lapses"], 1)

    def test_a_stalled_home_is_one_lapse_and_one_flip_however_often_it_is_asked(self) -> None:
        self.serve()
        self.clock.advance(250)
        self.readiness.note_probe_step("home_plugins")
        for _ in range(500):
            self.clock.advance(100)
            self.payload()
            self.readiness.service_audit_revision()
        payload = self.payload()
        self.assertEqual((payload["lapses"], payload["flips"]), (1, 2))
        self.assertEqual(payload["last_lapse"]["step"], "home_plugins")
        self.assertEqual(len([line for line in self.lines if line.startswith(LAPSE_LINE)]), 1)
        self.assertEqual(len([line for line in self.lines if line.startswith(FLIP_LINE)]), 2)

    def test_a_thousand_lapses_keep_one_record_and_count_them_all(self) -> None:
        for _ in range(1_000):
            self.serve()
            self.clock.advance(1_600)
            self.payload()
        payload = self.payload()
        self.assertEqual(payload["lapses"], 1_000)
        self.assertEqual(payload["flips"], 2_000)
        self.assertEqual(set(payload["last_lapse"]), {"step", "ms", "at"})
        self.assertEqual(set(payload["last_flip"]), {"to", "reason", "prior_ms", "at"})
        self.assertLess(len(json.dumps(payload)), 600)

    def test_the_node_audit_lapses_once_until_it_passes_again(self) -> None:
        for _ in range(5):
            self.readiness.note_node_audit(False, 2_100)
        self.readiness.note_node_audit(True, 30)
        self.readiness.note_node_audit(False, 2_000)
        payload = self.payload()
        self.assertEqual(payload["lapses"], 2)
        self.assertEqual((payload["last_lapse"]["step"], payload["last_lapse"]["ms"]), ("node_audit", 2_000))

    def test_a_fuse_flips_with_its_closed_reason(self) -> None:
        self.serve()
        self.readiness.note_policy_fused()
        self.assertEqual(self.payload()["last_flip"]["reason"], "policy_fused")

    def test_lines_are_printed_after_the_readiness_lock_is_released(self) -> None:
        held: list[bool] = []

        def probe_lock(line: str, err: bool = False) -> None:
            free = threading.Event()

            def take() -> None:
                if self.readiness._lock.acquire(timeout=0.5):
                    self.readiness._lock.release()
                    free.set()

            other = threading.Thread(target=take)
            other.start()
            other.join()
            held.append(not free.is_set())

        with patch.object(readiness_module, "emit", probe_lock):
            self.serve()
            self.clock.advance(POLICY_HEALTH_LEASE_NS // MS)
            self.payload()
            self.serve()
            self.readiness.begin_recovery()
        self.assertTrue(held)
        self.assertFalse(any(held))


class Counters:
    """The kernel's steal counter and the cgroup's throttling counter, as files the monitor reads."""

    def __init__(self, directory: str) -> None:
        self.proc_stat = Path(directory, "stat")
        self.cpu_stat = Path(directory, "cpu.stat")
        self.steal_ticks = 1_000
        self.throttled_usec = 5_000_000
        self.write()

    def write(self) -> None:
        self.proc_stat.write_text(
            f"cpu  100 0 50 9000 3 0 1 {self.steal_ticks} 0 0\n"
            "cpu0 50 0 25 4500 1 0 0 0 0 0\ncpu1 50 0 25 4500 2 0 1 0 0 0\n"
            "intr 12345 0 1\nctxt 999\n"
        )
        self.cpu_stat.write_text(
            "usage_usec 900\nnr_periods 10\nnr_throttled 2\n"
            f"throttled_usec {self.throttled_usec}\n"
        )


class Wait:
    """The probe wait, its clock driven by the test: it returns `late_ms` after it was due, while
    the host takes `steal_ms` and the quota holds the container back `throttled_ms`."""

    def __init__(self, clock: Clock, counters: Counters | None = None) -> None:
        self.clock = clock
        self.counters = counters
        self.late_ms = 0
        self.steal_ms = 0
        self.throttled_ms = 0
        # The monitor's loop stops after this many waits; None never stops it.
        self.rounds: int | None = None

    def wait(self, seconds: float) -> bool:
        self.clock.advance(int(seconds * 1000) + self.late_ms)
        if self.counters is not None:
            self.counters.steal_ticks += self.steal_ms * policy_monitor._ticks_per_second() // 1000
            self.counters.throttled_usec += self.throttled_ms * 1000
            self.counters.write()
        if self.rounds is not None:
            self.rounds -= 1
        return self.is_set()

    def is_set(self) -> bool:
        return self.rounds is not None and self.rounds <= 0


class StallTests(unittest.TestCase):
    def setUp(self) -> None:
        self.clock = Clock()
        self.lines: list[str] = []
        patcher = patch.object(readiness_module, "emit", lambda line, err=False: self.lines.append(line))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.readiness = Readiness("key", self.clock)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.counters = Counters(directory.name)
        self.monitor = policy_monitor.PolicyHealthMonitor(
            self.readiness,
            "key",
            monotonic_ns=self.clock,
            proc_stat=str(self.counters.proc_stat),
            cpu_stats=(str(self.counters.cpu_stat),),
        )
        self.waits = Wait(self.clock, self.counters)

    def payload(self) -> dict[str, object]:
        return self.readiness.readiness_response()[1]

    def test_a_wait_that_returns_late_records_the_stall_and_what_the_scheduler_did(self) -> None:
        self.waits.late_ms, self.waits.steal_ms, self.waits.throttled_ms = 1_200, 300, 900
        self.monitor.wait(self.waits, 0.5)
        payload = self.payload()
        self.assertEqual(payload["stalls"], 1)
        stall = payload["last_stall"]
        self.assertEqual(
            {key: stall[key] for key in ("late_ms", "steal_ms", "throttled_ms", "cpus")},
            {"late_ms": 1_200, "steal_ms": 300, "throttled_ms": 900, "cpus": 2},
        )
        # The supervisor's own CPU in that wait: a process that ran says so, one frozen says ~0.
        self.assertIsInstance(stall["cpu_ms"], int)
        self.assertGreaterEqual(stall["cpu_ms"], 0)
        self.assertRegex(str(stall["at"]), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
        self.assertEqual(len(self.lines), 1)
        name, _space, body = self.lines[0].partition(" ")
        self.assertEqual(name, "POOL_SUPERVISOR_STALL")
        fields = json.loads(body)
        self.assertEqual(
            set(fields), {"late_ms", "cpu_ms", "steal_ms", "throttled_ms", "cpus", "stalls"}
        )
        self.assertEqual((fields["late_ms"], fields["steal_ms"], fields["throttled_ms"]), (1_200, 300, 900))

    def test_a_counter_that_cannot_be_read_is_null(self) -> None:
        monitor = policy_monitor.PolicyHealthMonitor(
            self.readiness,
            "key",
            monotonic_ns=self.clock,
            proc_stat=str(self.counters.proc_stat) + ".absent",
            cpu_stats=(str(self.counters.cpu_stat) + ".absent",),
        )
        self.waits.late_ms = 2_000
        monitor.wait(self.waits, 0.5)
        stall = self.payload()["last_stall"]
        self.assertIsNone(stall["steal_ms"])
        self.assertIsNone(stall["throttled_ms"])
        self.assertIsNone(stall["cpus"])
        self.assertIn('"steal_ms":null', self.lines[0])
        for broken in (
            "",
            "cpux 1 2 3\ncpu0 1 2 3\n",
            "cpu 1 2\ncpu0 1 2\n",
            "cpu 1 2 3 4 5 6 7 x\ncpu0 1 2 3 4 5 6 7 0\n",
            # A total with no CPU under it gives nothing to set the steal against.
            "cpu 1 2 3 4 5 6 7 8\nintr 1\n",
        ):
            self.counters.proc_stat.write_text(broken)
            self.assertIsNone(policy_monitor.host_steal(str(self.counters.proc_stat)), broken)
        self.counters.cpu_stat.write_text("throttled_usec many\n")
        self.assertIsNone(policy_monitor.throttled_ms((str(self.counters.cpu_stat),)))

    def test_cgroup_v1_reports_throttling_in_nanoseconds(self) -> None:
        self.counters.cpu_stat.write_text("nr_periods 10\nnr_throttled 2\nthrottled_time 7000000\n")
        self.assertEqual(policy_monitor.throttled_ms((str(self.counters.cpu_stat),)), 7)

    def test_a_wait_on_time_records_nothing(self) -> None:
        for late_ms in (0, 3, policy_monitor.STALL_LATE_MS - 1):
            self.waits.late_ms = late_ms
            self.monitor.wait(self.waits, 0.5)
        payload = self.payload()
        self.assertNotIn("stalls", payload)
        self.assertNotIn("last_stall", payload)
        self.assertEqual(self.lines, [])
        self.waits.late_ms = policy_monitor.STALL_LATE_MS
        self.monitor.wait(self.waits, 0.5)
        self.assertEqual(self.payload()["stalls"], 1)

    def test_the_monitor_loop_times_its_own_waits(self) -> None:
        self.readiness.set_ready(True)
        self.waits.late_ms, self.waits.rounds = 1_300, 1
        with patch.object(policy_monitor, "probe_home_policy", lambda *_: ("healthy", INSTANCE)):
            self.monitor.run(self.waits)
        self.assertEqual(self.payload()["stalls"], 1)
        self.assertEqual(self.payload()["last_stall"]["late_ms"], 1_300)

    def test_every_stall_is_counted_and_only_one_that_may_lapse_the_lease_beats_the_line_gap(
        self,
    ) -> None:
        # 13:02's shape: a short stall, then within seconds the one that lapses the lease.
        for late_ms in (400, 300, 600, 1_600, 900, 1_000):
            self.waits.late_ms = late_ms
            self.monitor.wait(self.waits, 0.5)
        payload = self.payload()
        self.assertEqual(payload["stalls"], 6)
        self.assertEqual(payload["last_stall"]["late_ms"], 1_000)
        lined = [json.loads(line.partition(" ")[2]) for line in self.lines]
        # The first; one longer than any since; two as late as the lease's slack.
        self.assertEqual([line["late_ms"] for line in lined], [400, 600, 1_600, 1_000])
        self.assertEqual([line["stalls"] for line in lined], [1, 3, 4, 6])
        self.clock.advance(10_000)
        self.waits.late_ms = 300
        self.monitor.wait(self.waits, 0.5)
        self.assertEqual(len(self.lines), 5)
        self.assertEqual(json.loads(self.lines[4].partition(" ")[2])["stalls"], 7)


SETTLED = "POOL_READINESS_SETTLED "


class FirstReadyTests(unittest.TestCase):
    """The process's first ready waits until the policy monitor's last 5 waits came back on time."""

    def setUp(self) -> None:
        self.clock = Clock()
        self.lines: list[str] = []
        for module in (readiness_module, policy_monitor):
            patcher = patch.object(module, "emit", lambda line, err=False: self.lines.append(line))
            patcher.start()
            self.addCleanup(patcher.stop)
        healthy = patch.object(
            policy_monitor, "probe_home_policy", lambda *_: ("healthy", INSTANCE)
        )
        healthy.start()
        self.addCleanup(healthy.stop)
        self.readiness = Readiness("key", self.clock)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        counters = Counters(directory.name)
        self.monitor = policy_monitor.PolicyHealthMonitor(
            self.readiness,
            "key",
            monotonic_ns=self.clock,
            proc_stat=str(counters.proc_stat),
            cpu_stats=(str(counters.cpu_stat),),
        )
        self.waits = Wait(self.clock, counters)
        self.first = policy_monitor.FirstReady(self.readiness, self.clock)

    def audit(self) -> bool:
        """One passing services audit, as the supervisor's start loop reports it."""
        return self.first.set_ready(True, audit_revision=self.readiness.service_audit_revision())

    def turn(self, late_ms: int) -> bool:
        """One turn of the monitor's loop, a healthy probe and its 0.5 s wait, then one audit."""
        self.monitor.check_once()
        self.waits.late_ms = late_ms
        self.monitor.wait(self.waits, 0.5)
        return self.audit()

    def settled(self) -> list[dict[str, object]]:
        return [json.loads(line[len(SETTLED):]) for line in self.lines if line.startswith(SETTLED)]

    def assert_answers_as_before_any_audit(self) -> None:
        ready, payload, lease_ms = self.readiness.readiness_response()
        self.assertEqual((ready, lease_ms), (False, 0))
        # A live lease and no passed audit, never flipped; stall records are the stall line's own.
        self.assertEqual(
            {key: value for key, value in payload.items() if key not in ("stalls", "last_stall")},
            {
                "boot_id": self.readiness.boot_id,
                "started_at": self.readiness.started_at,
                "db_rtt_state": "pending",
                "refusal": "degraded",
            },
        )

    def test_slow_probes_hold_the_first_ready_as_late_waits_do(self) -> None:
        def slow(*_: object) -> tuple[str, str]:
            # The probe's own call runs past its 250 ms budget.
            self.clock.advance(policy_monitor.POLICY_PROBE_BUDGET_NS // 1_000_000 + 1)
            return "healthy", INSTANCE

        with patch.object(policy_monitor, "probe_home_policy", slow):
            for _ in range(6):
                self.assertFalse(self.turn(0))
                self.assert_answers_as_before_any_audit()
        # The last slow probe's own wait was on time, so it starts the new run: a probe exactly at
        # its budget is steady, and 4 such turns make the 5 waits.
        def at_budget(*_: object) -> tuple[str, str]:
            self.clock.advance(policy_monitor.POLICY_PROBE_BUDGET_NS // 1_000_000)
            return "healthy", INSTANCE

        with patch.object(policy_monitor, "probe_home_policy", at_budget):
            self.assertEqual([self.turn(0) for _ in range(4)], [False, False, False, True])
        self.assertEqual([line["ended"] for line in self.settled()], ["on_time"])

    def test_a_failed_probe_starts_the_on_time_run_again(self) -> None:
        for _ in range(4):
            self.assertFalse(self.turn(0))
        with patch.object(policy_monitor, "probe_home_policy", lambda *_: ("unavailable", None)):
            self.monitor.check_once()
        self.assertEqual(self.readiness.waits_on_time(), 0)

    def test_missed_probes_while_home_boots_leave_no_run_behind(self) -> None:
        # Connection refused while Home boots: the probe comes back missed at once, every wait on time.
        with patch.object(policy_monitor, "probe_home_policy", lambda *_: ("missed", None)):
            for _ in range(10):
                self.monitor.check_once()
                self.waits.late_ms = 0
                self.monitor.wait(self.waits, 0.5)
        # Home is up: the first healthy probe renews the lease, and the audit still waits.
        self.monitor.check_once()
        self.assertFalse(self.audit())
        self.assert_answers_as_before_any_audit()

    def test_a_refused_lease_refresh_starts_the_on_time_run_again(self) -> None:
        for _ in range(4):
            self.assertFalse(self.turn(0))
        with patch.object(self.readiness, "refresh_policy_lease", lambda *_: False):
            self.assertEqual(self.monitor.check_once(), "unavailable")
        self.assertEqual(self.readiness.waits_on_time(), 0)

    def test_a_wait_overdue_but_not_yet_back_holds_the_first_ready(self) -> None:
        for _ in range(5):
            self.monitor.check_once()
            self.waits.late_ms = 0
            self.monitor.wait(self.waits, 0.5)
        # The next wait is under way and already 300 ms past due: a stall the monitor hasn't seen.
        self.monitor.check_once()
        self.readiness.note_wait_started(0.5)
        self.clock.advance(800)
        self.assertFalse(self.audit())
        self.assert_answers_as_before_any_audit()

    def test_a_failed_audit_between_passing_ones_keeps_the_bound_from_the_first(self) -> None:
        self.assertFalse(self.turn(500))
        self.assertFalse(self.first.set_ready(False, audit_revision=self.readiness.service_audit_revision()))
        for _ in range(29):
            self.assertFalse(self.turn(500))
        self.assertTrue(self.turn(500))
        self.assertEqual([line["ended"] for line in self.settled()], ["bound"])
        self.assertEqual(self.settled()[0]["held_ms"], 30_000)

    def test_the_hold_gives_way_before_the_start_s_deadline(self) -> None:
        self.monitor.check_once()
        margin_s = policy_monitor.FIRST_READY_DEADLINE_MARGIN_NS / 1_000_000_000
        revision = self.readiness.service_audit_revision()
        self.assertFalse(self.first.set_ready(True, audit_revision=revision, remaining_s=margin_s + 1))
        self.assertTrue(self.first.set_ready(True, audit_revision=revision, remaining_s=margin_s))
        self.assertEqual([line["ended"] for line in self.settled()], ["deadline"])

    def test_a_quiet_start_is_ready_after_five_waits_on_time(self) -> None:
        # The audit can pass before the monitor has timed a single wait; that is held too.
        self.monitor.check_once()
        self.assertFalse(self.audit())
        self.assert_answers_as_before_any_audit()
        for _ in range(4):
            self.assertFalse(self.turn(0))
            self.assert_answers_as_before_any_audit()
        self.assertTrue(self.turn(0))
        self.assertTrue(self.readiness.snapshot()[0])
        self.assertEqual(self.settled(), [{"held_ms": 2_500, "ended": "on_time"}])

    def test_a_starved_start_holds_the_first_ready_until_five_waits_in_a_row_are_on_time(
        self,
    ) -> None:
        # 250 ms late is a stall and starts the count again; 249 ms is on time.
        for late_ms in (250, 249, 0, 0, 0, 250, 249, 0, 0, 0):
            self.assertFalse(self.turn(late_ms), late_ms)
            self.assert_answers_as_before_any_audit()
        self.assertTrue(self.turn(0))
        # From the first passing audit, 750 ms in, to the eleventh turn's.
        self.assertEqual(self.settled(), [{"held_ms": 5_748, "ended": "on_time"}])

    def test_waits_late_throughout_hold_the_first_ready_for_30_seconds_at_most(self) -> None:
        # Every 0.5 s wait returns 500 ms late, a stall each turn, inside the 1.5 s lease.
        for _ in range(30):
            self.assertFalse(self.turn(500))
        self.assert_answers_as_before_any_audit()
        self.assertTrue(self.turn(500))
        self.assertEqual(self.settled(), [{"held_ms": 30_000, "ended": "bound"}])

    def test_only_the_first_ready_is_held(self) -> None:
        for late_ms in (0, 0, 0, 0):
            self.assertFalse(self.turn(late_ms))
        self.assertTrue(self.turn(0))
        # A wait 1.2 s late lapses the lease; the next healthy probe renews it, and the runtime is
        # ready again at once, though no wait since that stall has come back on time.
        self.assertFalse(self.turn(1_200))
        self.assertEqual(self.readiness.snapshot()[1]["refusal"], "policy_unproven")
        self.monitor.check_once()
        self.assertEqual(self.readiness.waits_on_time(), 0)
        self.assertTrue(self.audit())
        self.assertEqual(self.readiness.snapshot()[1]["last_flip"]["to"], "ready")

    def test_the_settled_line_comes_once(self) -> None:
        self.assertFalse(self.turn(600))
        for late_ms in (0, 0, 0, 0, 0, 0, 1_200, 0, 300, 0):
            self.turn(late_ms)
        self.monitor.check_once()
        self.assertTrue(self.audit())
        settled = [line for line in self.lines if line.startswith(SETTLED)]
        self.assertEqual(settled, [SETTLED + '{"held_ms":2500,"ended":"on_time"}'])

    def test_without_a_monitor_timing_its_waits_the_first_ready_is_not_held(self) -> None:
        # A real monitor times its waits from construction; only stand-ins in tests time none.
        readiness = Readiness("key", self.clock)
        self.assertIsNone(readiness.waits_on_time())
        self.assertTrue(readiness.refresh_policy_lease(INSTANCE))
        first = policy_monitor.FirstReady(readiness, self.clock)
        self.assertTrue(first.set_ready(True, audit_revision=readiness.service_audit_revision()))
        self.assertEqual(self.settled(), [])


class LapseFlipPrivacyTests(unittest.TestCase):
    """The records stay closed whatever Home's and the plugin's answers to the probe carry."""

    def test_lapse_and_flip_records_never_carry_the_probe_answers(self) -> None:
        secret = "planted-probe-secret-" + TOKEN_SENTINEL
        now = [10_000_000_000]
        lines: list[str] = []
        state = Readiness(secret, lambda: now[0])
        home_answer = {
            "plugins_enabled": True,
            "plugins": [
                {
                    "id": POLICY_PLUGIN_ID,
                    "registered": True,
                    "enabled": True,
                    "effective_enabled": True,
                    "note": secret,
                }
            ],
            "error": secret,
        }
        calls = iter([True, False])

        def plugin_answer(_path: str, body: dict[str, str], **_kwargs: object) -> tuple[int, dict[str, object]]:
            if next(calls):
                return 200, {"ok": True, "nonce": body["nonce"], "instance": "a" * 32, "error": secret}
            return 0, {"error": secret, "address": "10.0.0.9:8329"}

        with (
            patch.object(readiness_module, "emit", lambda line, err=False: lines.append(line)),
            patch.object(policy_monitor, "request_json", lambda *_a, **_k: (200, home_answer)),
            patch.object(policy_monitor, "native_policy_request", plugin_answer),
        ):
            self.assertTrue(state.refresh_policy_lease("a" * 32))
            state.set_ready(True, audit_revision=state.service_audit_revision())
            now[0] += 300_000_000
            # The first probe never sees its log line and the second loses the plugin.
            self.assertEqual(policy_monitor.probe_home_policy(secret, state)[0], "missed")
            self.assertEqual(policy_monitor.probe_home_policy(secret, state)[0], "missed")
            state.note_node_audit(False, 2_000)
            now[0] += 2_000_000_000
            _ready, payload, _lease = state.readiness_response()
        self.assertIn("last_lapse", payload)
        self.assertIn("last_flip", payload)
        rendered = json.dumps(payload) + "\n".join(lines)
        for leaked in (secret, TOKEN_SENTINEL, "10.0.0.9", "8329", "note", "error"):
            self.assertNotIn(leaked, rendered)
        for line in lines:
            name, _space, body = line.partition(" ")
            self.assertIn(name, {"POOL_READINESS_LAPSE", "POOL_READINESS_FLIP"})
            fields = json.loads(body)
            if name == "POOL_READINESS_LAPSE":
                self.assertEqual(set(fields), {"step", "ms"})
                self.assertIn(fields["step"], LAPSE_STEPS)
            else:
                self.assertEqual(set(fields), {"to", "reason", "prior_ms"})
                self.assertIn(fields["reason"], {"restored", "policy_fused", "policy_unproven", "degraded"})
            self.assertTrue(all(isinstance(value, (str, int)) for value in fields.values()))


if __name__ == "__main__":
    unittest.main()
