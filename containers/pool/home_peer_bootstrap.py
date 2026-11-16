"""The retained Home can add private peers without replacing its serving process."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import sys
import threading

from .home_peer import HomePeers

WITNESS = Path("/dev/shm/cliproxy-pool/home-peer-start.json")


def main() -> None:
    options = json.loads(sys.argv[1])
    if (set(options) != {"sourceSha", "nonce", "bootId"}
            or any(not isinstance(value, str) or not value or len(value) > 256
                   for value in options.values())):
        raise ValueError("invalid peer bootstrap binding")
    status = Path("/proc/self/stat").read_text()
    record = {
        **options,
        "pid": os.getpid(),
        "startTicks": status[status.rfind(")") + 2:].split()[19],
        "ready": False,
    }
    # A second exec on this incarnation cannot start another listener, even after a lost reply.
    with os.fdopen(os.open(WITNESS, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(record, output)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    peers = HomePeers(0)
    try:
        peers.start()
        record["ready"] = True
        temporary = WITNESS.with_suffix(".ready")
        with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            json.dump(record, output)
        os.replace(temporary, WITNESS)
        print(json.dumps(record, separators=(",", ":")), flush=True)
        stopped.wait()
    finally:
        peers.close()


if __name__ == "__main__":
    main()
