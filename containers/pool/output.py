"""Supervisor output that can never block the process writing it.

Home's own stdout is a pipe that the supervisor's reader drains. If the reader waited on the
container's stdout, a slow log consumer would stop the reader, fill Home's pipe and stall Home on
its next log write. Every supervisor line therefore goes through a bounded queue: a writer thread
does the blocking write, and a full queue drops lines and counts them instead of waiting. The last
lines are also kept, with sequence numbers, so `/diagnostics` can serve them on demand.
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
        self._queue: queue.Queue[tuple[bool, str]] = queue.Queue(maxsize=capacity)
        self._history: collections.deque[tuple[int, str]] = collections.deque(maxlen=history)
        self._lock = threading.Lock()
        self._seq = 0
        self._dropped = 0
        self._dropped_total = 0
        self._writer: threading.Thread | None = None

    def emit(self, line: str, err: bool = False) -> None:
        with self._lock:
            self._seq += 1
            self._history.append((self._seq, line))
        stream = sys.stderr if err else sys.stdout
        if stream is not self._target(err):
            # A replaced stream (tests, embedding) is the caller's own and is written in place.
            _write(stream, line)
            return
        self._start_writer()
        try:
            self._queue.put_nowait((err, line))
        except queue.Full:
            with self._lock:
                self._dropped += 1
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
            if self._queue.unfinished_tasks == 0:
                return True
            time.sleep(0.01)
        return self._queue.unfinished_tasks == 0

    def _target(self, err: bool) -> TextIO | None:
        if err:
            return self._err if self._err is not None else sys.__stderr__
        return self._out if self._out is not None else sys.__stdout__

    def _start_writer(self) -> None:
        with self._lock:
            if self._writer is not None:
                return
            self._writer = threading.Thread(target=self._write_loop, daemon=True)
            self._writer.start()

    def _write_loop(self) -> None:
        while True:
            err, line = self._queue.get()
            try:
                _write(self._target(err), line)
                with self._lock:
                    dropped, self._dropped = self._dropped, 0
                if dropped:
                    _write(
                        self._target(False),
                        DROPPED_MARKER + json.dumps({"count": dropped}, separators=(",", ":")),
                    )
            finally:
                self._queue.task_done()


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
