"""Supervisor output that can never block the process writing it.

Home's own stdout is a pipe that the supervisor's reader drains. If the reader waited on the
container's stdout, a slow log consumer would stop the reader, fill Home's pipe and stall Home on
its next log write. Every supervisor line therefore goes through a bounded queue per stream: a
writer thread does the blocking write, and a full queue drops lines and counts them instead of
waiting. Stdout and stderr have separate queues and writers, so a stalled stdout never holds back
the stop and failure records on stderr. The last lines are also kept, with sequence numbers, so
`/diagnostics` can serve them on demand.
"""

from __future__ import annotations

import collections
import json
import queue
import sys
import threading
import time
from typing import TextIO

QUEUE_LINES = 4096
HISTORY_LINES = 256
DROPPED_MARKER = "POOL_OUTPUT_DROPPED "


class _Lane:
    def __init__(self, capacity: int) -> None:
        self.queue: queue.Queue[str | None] = queue.Queue(maxsize=capacity)
        self.dropped = 0
        self.writer: threading.Thread | None = None


class Output:
    def __init__(
        self,
        capacity: int = QUEUE_LINES,
        history: int = HISTORY_LINES,
        out: TextIO | None = None,
        err: TextIO | None = None,
    ) -> None:
        # None means the process's own streams, looked up when used.
        self._out = out
        self._err = err
        self._lanes = {False: _Lane(capacity), True: _Lane(capacity)}
        self._history: collections.deque[tuple[int, str]] = collections.deque(maxlen=history)
        # Reentrant: emit can run from sys.unraisablehook while this thread holds the lock.
        self._lock = threading.RLock()
        self._seq = 0
        self._dropped_total = 0

    def emit(self, line: str, err: bool = False) -> None:
        with self._lock:
            self._seq += 1
            self._history.append((self._seq, line))
        stream = sys.stderr if err else sys.stdout
        if stream is not self._target(err):
            # A replaced stream (tests, embedding) is the caller's own and is written in place.
            _write(stream, line)
            return
        lane = self._lanes[err]
        self._ensure_writer(err)
        try:
            lane.queue.put_nowait(line)
        except queue.Full:
            with self._lock:
                lane.dropped += 1
                self._dropped_total += 1

    def lines_after(self, seq: int) -> list[tuple[int, str]]:
        with self._lock:
            return [entry for entry in self._history if entry[0] > seq]

    def dropped_total(self) -> int:
        with self._lock:
            return self._dropped_total

    def drain(self, timeout: float) -> bool:
        """Wait up to `timeout` for queued lines to be written; never longer."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._drained():
                return True
            time.sleep(0.01)
        return self._drained()

    def close(self, timeout: float = 1) -> None:
        """Stop the writers once their queued lines are written; lines still blocked are left."""
        for lane in self._lanes.values():
            writer = lane.writer
            if writer is not None and writer.is_alive():
                try:
                    lane.queue.put(None, timeout=timeout)
                except queue.Full:
                    continue
                writer.join(timeout)

    def _drained(self) -> bool:
        return all(lane.queue.unfinished_tasks == 0 for lane in self._lanes.values())

    def _target(self, err: bool) -> TextIO | None:
        if err:
            return self._err if self._err is not None else sys.__stderr__
        return self._out if self._out is not None else sys.__stdout__

    def _ensure_writer(self, err: bool) -> None:
        with self._lock:
            lane = self._lanes[err]
            if lane.writer is not None and lane.writer.is_alive():
                return
            writer = threading.Thread(target=self._write_loop, args=(err,), daemon=True)
            try:
                writer.start()
            except RuntimeError:
                # No thread now (interpreter shutdown, resource limits): the line stays queued and
                # the next emit tries again.
                return
            lane.writer = writer

    def _write_loop(self, err: bool) -> None:
        lane = self._lanes[err]
        while True:
            line = lane.queue.get()
            try:
                if line is None:
                    return
                stream = self._target(err)
                _write(stream, line)
                with self._lock:
                    dropped, lane.dropped = lane.dropped, 0
                if dropped:
                    _write(stream, DROPPED_MARKER + json.dumps({"count": dropped}, separators=(",", ":")))
            except Exception:
                # One bad write must not end the only writer for this stream.
                pass
            finally:
                lane.queue.task_done()


def _write(stream: TextIO | None, line: str) -> None:
    if stream is None:
        return
    try:
        stream.write(line + "\n")
        stream.flush()
    except (OSError, ValueError):
        pass


OUTPUT = Output()


def emit(line: str, err: bool = False) -> None:
    OUTPUT.emit(line, err)
