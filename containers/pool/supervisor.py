#!/usr/bin/env python3
"""Start and supervise Home plus its single local CLIProxyAPI node."""

from __future__ import annotations

import pathlib
import json
import signal
import subprocess
import sys
import threading
import time
from typing import Any

from .pool_contract import (
    ROOT,
    StartupError,
    apply_pool_config,
    atomic_write,
    boolean_env,
    check_services,
    child_environment,
    cluster_yaml,
    create_node_jwt,
    env_required,
    home_boot_requires_import,
    management_ready,
    bootstrap_yaml,
    require_tmpfs,
)
from .readiness import Readiness, start_ready_server


HOME_BINARY = "/usr/local/bin/cliproxy-home"
NODE_BINARY = "/usr/local/bin/cliproxy-node"
BOOTSTRAP_MARKER = "database config is empty; run with -import first"
STARTUP_TIMEOUT_SECONDS = 180


def privacy_audit_line(name: str, line: str) -> str | None:
    """Allow only the startup audit's counts."""
    marker = "POOL_PRIVACY_AUDIT "
    if name != "home" or marker not in line:
        return None
    try:
        # Logrus quotes and escapes a JSON message in its text format.
        if 'msg="' in line:
            line = json.JSONDecoder().raw_decode(line.split("msg=", 1)[1])[0]
        elif line.startswith("{"):
            line = json.loads(line).get("msg", "")
        if not isinstance(line, str) or marker not in line:
            return None
        value = json.JSONDecoder().raw_decode(line.split(marker, 1)[1])[0]
    except (ValueError, TypeError):
        return None
    fields = {"usage_rows", "purged_rows", "active_key_count", "matched_active_key_copies", "deleted_key_count", "unknown_key_count"}
    if not isinstance(value, dict) or set(value) != fields:
        return None
    if any(type(value[key]) is not int or value[key] < 0 for key in fields):
        return None
    return marker + json.dumps(value, sort_keys=True, separators=(",", ":"))


class Child:
    def __init__(
        self,
        name: str,
        command: list[str],
        env: dict[str, str],
        cwd: pathlib.Path,
    ) -> None:
        self.name = name
        self.config_empty = threading.Event()
        self.process = subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_output, daemon=True)
        self._reader.start()

    def _read_output(self) -> None:
        stream = self.process.stdout
        if stream is None:
            return
        while line := stream.readline(8192):
            if BOOTSTRAP_MARKER in line:
                self.config_empty.set()
            # Provider errors can contain full responses. Do not forward them.
            safe = privacy_audit_line(self.name, line)
            if safe is not None:
                print(safe, flush=True)


def wait_for_home(
    child: Child,
    management_key: str,
    stop: threading.Event,
) -> str:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    while not stop.is_set() and time.monotonic() < deadline:
        exit_code = child.process.poll()
        if exit_code is not None:
            child._reader.join(timeout=0.2)
            if home_boot_requires_import(exit_code, child.config_empty.is_set()):
                return "empty"
            raise StartupError(f"Home exited before readiness (exit {exit_code})")
        if management_ready(management_key):
            return "ready"
        time.sleep(0.5)
    if stop.is_set():
        return "stop"
    raise StartupError("Home did not become ready before the startup timeout")


def import_initial_config(
    management_key: str,
    allow_remote: bool,
) -> None:
    seed_path = ROOT / "bootstrap.yaml"
    atomic_write(seed_path, bootstrap_yaml(allow_remote))
    try:
        result = subprocess.run(
            [HOME_BINARY, "-config", str(seed_path), "-import"],
            cwd=ROOT,
            env=child_environment("home", management_key),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=STARTUP_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StartupError("Home initial configuration import failed") from error
    finally:
        seed_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise StartupError("Home initial configuration import failed")


def terminate_children(children: list[Child]) -> None:
    for child in children:
        if child.process.poll() is None:
            child.process.terminate()
    deadline = time.monotonic() + 15
    for child in children:
        remaining = max(0.0, deadline - time.monotonic())
        try:
            child.process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            if child.process.poll() is None:
                child.process.kill()
                child.process.wait()


def main() -> int:
    children: list[Child] = []
    ready_server = None
    readiness = None
    stop = threading.Event()
    original_signals: dict[int, Any] = {}
    try:
        management_key = env_required("POOL_MANAGEMENT_KEY")
        database_url = env_required("POOL_DATABASE_URL")
        allow_remote = boolean_env("POOL_MANAGEMENT_ALLOW_REMOTE", False)
        require_tmpfs(pathlib.Path("/dev/shm"))
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        pathlib.Path(ROOT / "tmp").mkdir(mode=0o700, exist_ok=True)
        readiness = Readiness(management_key)
        ready_server = start_ready_server(readiness)

        def request_stop(signum: int, frame: Any) -> None:
            stop.set()

        for signum in (signal.SIGTERM, signal.SIGINT):
            original_signals[signum] = signal.signal(signum, request_stop)

        atomic_write(ROOT / "cluster.yaml", cluster_yaml(database_url))
        home_child = Child(
            "home",
            [HOME_BINARY, "-addr", "0.0.0.0:8327"],
            child_environment("home", management_key),
            ROOT,
        )
        children.append(home_child)
        home_state = wait_for_home(home_child, management_key, stop)
        if home_state == "stop":
            return 0
        if home_state == "empty":
            home_child.process.wait()
            import_initial_config(management_key, allow_remote)
            home_child = Child(
                "home",
                [HOME_BINARY, "-addr", "0.0.0.0:8327"],
                child_environment("home", management_key),
                ROOT,
            )
            children[-1] = home_child
            home_state = wait_for_home(home_child, management_key, stop)
            if home_state == "stop":
                return 0
            if home_state != "ready":
                raise StartupError("Home did not load the imported configuration")

        apply_pool_config(management_key, allow_remote)
        node_id, home_jwt = create_node_jwt(management_key)
        node_child = Child(
            "node",
            [NODE_BINARY, "-home-disable-cluster-discovery"],
            child_environment("node", management_key, home_jwt, readiness.boot_id),
            ROOT / "node",
        )
        children.append(node_child)

        deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
        while not stop.is_set() and time.monotonic() < deadline:
            for child in children:
                exit_code = child.process.poll()
                if exit_code is not None:
                    raise StartupError(
                        f"{child.name} exited before the pool was healthy (exit {exit_code})"
                    )
            if check_services(management_key, node_id):
                readiness.set_ready(True)
                break
            time.sleep(0.5)
        if stop.is_set():
            return 0
        if not readiness.snapshot()[0]:
            raise StartupError("Home and node did not become healthy before timeout")

        while not stop.wait(2):
            for child in children:
                exit_code = child.process.poll()
                if exit_code is not None:
                    readiness.set_ready(False)
                    raise StartupError(
                        f"{child.name} exited unexpectedly (exit {exit_code})"
                    )
            readiness.set_ready(check_services(management_key, node_id))
        return 0
    except StartupError as error:
        print(f"[pool] {error}", file=sys.stderr, flush=True)
        return 1
    except Exception as error:
        print(f"[pool] startup failed ({type(error).__name__})", file=sys.stderr, flush=True)
        return 1
    finally:
        if readiness is not None:
            readiness.set_ready(False)
        if ready_server is not None:
            ready_server.shutdown()
            ready_server.server_close()
        terminate_children(children)
        (ROOT / "bootstrap.yaml").unlink(missing_ok=True)
        (ROOT / "cluster.yaml").unlink(missing_ok=True)
        for signum, handler in original_signals.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    sys.exit(main())
