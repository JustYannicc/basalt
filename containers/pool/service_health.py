"""Keep process probes independent of the slower database-backed node audit."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable


class ServiceHealth:
    AUDIT_INTERVAL = 60
    AUDIT_BUDGET = 4

    def __init__(
        self,
        key: str,
        node_id: str,
        full_check: Callable[[str, str], bool],
        fast_check: Callable[[str], bool],
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        # Construction follows the generation's successful startup contract.
        self._key = key
        self._node_id = node_id
        self._full_check = full_check
        self._fast_check = fast_check
        self._clock = clock
        self._lock = threading.Lock()
        self._epoch = 0
        self._fast_ok = True
        self._full_ok = True
        self._running = False
        self._audit_error: Exception | None = None
        self._next_audit = clock() + self.AUDIT_INTERVAL
        self._valid_until = self._next_audit + self.AUDIT_BUDGET

    def invalidate(self) -> None:
        with self._lock:
            self._epoch += 1
            self._fast_ok = False
            self._full_ok = False

    def check(self) -> bool:
        with self._lock:
            if self._audit_error is not None:
                raise self._audit_error
        fast_ok = self._fast_check(self._key)
        audit_epoch: int | None = None
        with self._lock:
            now = self._clock()
            if self._audit_error is not None:
                raise self._audit_error
            if not fast_ok:
                if self._fast_ok:
                    self._epoch += 1
                self._fast_ok = False
                self._full_ok = False
                return False
            if not self._fast_ok:
                self._next_audit = now
            self._fast_ok = True
            if not self._running and now >= self._next_audit:
                self._running = True
                audit_epoch = self._epoch
            ready = self._full_ok and now < self._valid_until
        if audit_epoch is not None:
            # Never put a database wait on the supervisor's child-exit path.
            threading.Thread(
                target=self._audit, args=(audit_epoch, now + self.AUDIT_BUDGET), daemon=True
            ).start()
        return ready

    def _audit(self, epoch: int, deadline: float) -> None:
        error = None
        try:
            healthy = self._full_check(self._key, self._node_id)
        except Exception as audit_error:
            healthy = False
            error = audit_error
        with self._lock:
            self._running = False
            if epoch != self._epoch:
                return
            self._audit_error = error
            now = self._clock()
            healthy = healthy and now < deadline
            self._full_ok = healthy
            self._next_audit = now + (self.AUDIT_INTERVAL if healthy else 2)
            self._valid_until = self._next_audit + self.AUDIT_BUDGET
