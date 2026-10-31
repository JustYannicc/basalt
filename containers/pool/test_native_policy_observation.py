"""Observe production monitor milestones for the loaded Home plugin proof."""

from __future__ import annotations

import threading

try:
    from . import policy_monitor, readiness
    from .policy_monitor import PolicyHealthMonitor, ProbeState
except ImportError:
    from pool import policy_monitor, readiness
    from pool.policy_monitor import PolicyHealthMonitor, ProbeState


def run_monitor_until_policy_lease(
    monitor: PolicyHealthMonitor,
    ready: readiness.Readiness,
    timeout_seconds: float,
) -> tuple[bool, list[ProbeState]]:
    lease_acquired = threading.Event()
    stop = threading.Event()
    states: list[ProbeState] = []
    original_refresh = ready.refresh_policy_lease
    original_check = monitor.check_once

    def observe_refresh(instance_id: str) -> bool:
        accepted = original_refresh(instance_id)
        if accepted:
            lease_acquired.set()
        return accepted

    def observe_check() -> ProbeState:
        state = original_check()
        states.append(state)
        return state

    ready.refresh_policy_lease = observe_refresh
    monitor.check_once = observe_check
    thread = threading.Thread(
        target=monitor.run,
        args=(stop,),
        daemon=True,
        name="native-policy-test-monitor-startup",
    )
    try:
        thread.start()
        acquired = lease_acquired.wait(timeout_seconds)
    finally:
        stop.set()
        thread.join(timeout=max(1.0, timeout_seconds))
        ready.refresh_policy_lease = original_refresh
        monitor.check_once = original_check
    if thread.is_alive():
        raise AssertionError("production policy monitor run loop did not stop after its bounded probe")
    return acquired, states
