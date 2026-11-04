#!/usr/bin/env python3
"""Start and supervise Home plus its single local CLIProxyAPI node."""

from __future__ import annotations

import pathlib
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

from .child_signals import (
    NativePolicyFuseParser,
    NativePolicyProbeParser,
    safe_child_output_line,
)
from .policy_monitor import PolicyHealthMonitor
from .pool_contract import (
    ROOT,
    StartupError,
    apply_pool_config,
    atomic_write,
    boolean_env,
    bootstrap_yaml,
    check_services,
    child_environment,
    cluster_yaml,
    create_node_jwt,
    env_required,
    home_boot_requires_import,
    management_ready,
    require_tmpfs,
)
from .readiness import Readiness, start_ready_server
from .recovery import HomeExited, HomeRecovery
from .recovery_deadline import RecoveryCancelled, current_deadline, operation_timeout
from .runtime_signals import (
    FailureCategory,
    StartupPhase,
    install_error_handlers,
    report_child_exit,
    report_failure,
    startup_phase,
    try_monotonic_ns,
)

HOME_BINARY = "/usr/local/bin/cliproxy-home"
NODE_BINARY = "/usr/local/bin/cliproxy-node"
BOOTSTRAP_MARKER = "database config is empty; run with -import first"
STARTUP_TIMEOUT_SECONDS = 180


class Child:
    def __init__(
        self,
        name: str,
        command: list[str],
        env: dict[str, str],
        cwd: pathlib.Path,
        on_policy_fused: Callable[[], None] | None = None,
        on_policy_probe: Callable[[str], None] | None = None,
    ) -> None:
        self.name = name
        self._on_policy_fused = on_policy_fused
        self._on_policy_probe = on_policy_probe
        self._fuse_parser = NativePolicyFuseParser()
        self._policy_probe_parser = NativePolicyProbeParser()
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
            fused = self._fuse_parser.feed(self.name, line)
            if fused is not None:
                print(fused, flush=True)
                if self._on_policy_fused is not None:
                    self._on_policy_fused()
                continue
            probe_nonce = self._policy_probe_parser.feed(self.name, line)
            if probe_nonce is not None:
                if self._on_policy_probe is not None:
                    self._on_policy_probe(probe_nonce)
                continue
            # Provider errors can contain full responses. Do not forward them.
            safe = safe_child_output_line(self.name, line)
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
            try:
                drain_exited_home(child)
            except Exception:
                report_child_exit(child.name, exit_code, FailureCategory.HOME_STARTUP)
                raise
            if home_boot_requires_import(exit_code, child.config_empty.is_set()):
                return "empty"
            report_child_exit(child.name, exit_code, FailureCategory.HOME_STARTUP)
            raise HomeExited(exit_code)
        operation_timeout(STARTUP_TIMEOUT_SECONDS)
        if management_ready(management_key):
            return "ready"
        stop.wait(operation_timeout(0.5))
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
        report_child_exit(
            "home_import", result.returncode, FailureCategory.HOME_STARTUP
        )
        raise StartupError("Home initial configuration import failed")


def drain_exited_home(child: Child) -> None:
    """Observe every buffered fuse before retiring the generation; fail closed."""
    child.process.wait(timeout=operation_timeout(1))
    reader = getattr(child, "_reader", None)
    if reader is not None:
        reader.join(timeout=operation_timeout(1))
        if reader.is_alive():
            raise StartupError("Home output reader did not finish")


def terminate_children(children: list[Child]) -> None:
    deadline = current_deadline()

    def remaining(maximum: float) -> float:
        return maximum if deadline is None else deadline.cleanup_remaining(maximum)

    for child in children:
        if child.process.poll() is None:
            child.process.terminate()
    grace_until = time.monotonic() + remaining(14 if deadline else 15)
    for child in children:
        try:
            child.process.wait(
                timeout=remaining(
                    max(0, grace_until - time.monotonic() - (1 if deadline else 0))
                )
            )
        except subprocess.TimeoutExpired:
            pass
    # Kill every remaining owned child before waiting for any one of them.
    for child in children:
        if child.process.poll() is None:
            child.process.kill()
    for child in children:
        child.process.wait(timeout=remaining(1) if deadline else 1)


def main(stop: threading.Event | None = None) -> int:
    supervisor_started_ns = try_monotonic_ns()
    children: list[Child] = []
    ready_server = None
    readiness = None
    policy_monitor_thread = None
    stop = threading.Event() if stop is None else stop
    original_signals: dict[int, Any] = {}
    category = FailureCategory.CONFIGURATION
    recovery_cleanup_done = False
    try:
        management_key = env_required("POOL_MANAGEMENT_KEY")
        database_url = env_required("POOL_DATABASE_URL")
        allow_remote = boolean_env("POOL_MANAGEMENT_ALLOW_REMOTE", False)
        require_tmpfs(pathlib.Path("/dev/shm"))
        ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
        pathlib.Path(ROOT / "tmp").mkdir(mode=0o700, exist_ok=True)
        readiness = Readiness(management_key)
        ready_server = start_ready_server(readiness)
        policy_monitor = PolicyHealthMonitor(readiness, management_key)
        policy_monitor_thread = threading.Thread(
            target=policy_monitor.run,
            args=(stop,),
            daemon=True,
        )
        policy_monitor_thread.start()

        def request_stop(signum: int, frame: Any) -> None:
            stop.set()

        for signum in (signal.SIGTERM, signal.SIGINT):
            original_signals[signum] = signal.signal(signum, request_stop)

        atomic_write(ROOT / "cluster.yaml", cluster_yaml(database_url))

        def launch_generation(recovering: bool = False) -> str:
            """Reuse boot, child capture and health gates; import only on first boot."""
            nonlocal category
            if not recovering:
                category = FailureCategory.HOME_STARTUP
            generation = readiness.generation()
            with startup_phase(StartupPhase.HOME_BOOT, supervisor_started_ns):
                operation_timeout(STARTUP_TIMEOUT_SECONDS)
                home_child = Child(
                    "home",
                    [HOME_BINARY, "-addr", "0.0.0.0:8327"],
                    child_environment("home", management_key),
                    ROOT,
                    lambda generation=generation: readiness.note_policy_fused(
                        generation
                    ),
                    lambda nonce, generation=generation: readiness.note_policy_probe(
                        nonce, generation
                    ),
                )
                children.append(home_child)
                readiness.enable_policy_observations()
                home_state = wait_for_home(home_child, management_key, stop)
            if home_state == "stop":
                raise RecoveryCancelled()
            if home_state == "empty" and recovering:
                report_child_exit(
                    home_child.name, home_child.process.returncode, category
                )
                raise StartupError("Home config became empty during recovery")
            if home_state == "empty":
                with startup_phase(
                    StartupPhase.BOOTSTRAP_IMPORT, supervisor_started_ns
                ):
                    home_child.process.wait()
                    import_initial_config(management_key, allow_remote)
                readiness.home_process_restarted()
                generation = readiness.generation()
                with startup_phase(StartupPhase.HOME_BOOT, supervisor_started_ns):
                    home_child = Child(
                        "home",
                        [HOME_BINARY, "-addr", "0.0.0.0:8327"],
                        child_environment("home", management_key),
                        ROOT,
                        lambda generation=generation: readiness.note_policy_fused(
                            generation
                        ),
                        lambda nonce, generation=generation: (
                            readiness.note_policy_probe(nonce, generation)
                        ),
                    )
                    children[-1] = home_child
                    readiness.enable_policy_observations()
                    home_state = wait_for_home(home_child, management_key, stop)
                if home_state == "stop":
                    raise RecoveryCancelled()
                if home_state != "ready":
                    raise StartupError("Home did not load the imported configuration")

            with startup_phase(StartupPhase.CONFIG_APPLY, supervisor_started_ns):
                operation_timeout(STARTUP_TIMEOUT_SECONDS)
                apply_pool_config(management_key, allow_remote)
            if not recovering:
                category = FailureCategory.NODE_STARTUP
            with startup_phase(StartupPhase.NODE_LAUNCH, supervisor_started_ns):
                operation_timeout(STARTUP_TIMEOUT_SECONDS)
                node_id, home_jwt = create_node_jwt(management_key)
                operation_timeout(STARTUP_TIMEOUT_SECONDS)
                node_child = Child(
                    "node",
                    [NODE_BINARY, "-home-disable-cluster-discovery"],
                    child_environment(
                        "node", management_key, home_jwt, readiness.boot_id
                    ),
                    ROOT / "node",
                )
                children.append(node_child)

            if not recovering:
                category = FailureCategory.INITIAL_HEALTH
            with startup_phase(StartupPhase.INITIAL_HEALTH, supervisor_started_ns):
                deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
                while not stop.is_set() and time.monotonic() < deadline:
                    failed = [(child, child.process.poll()) for child in children]
                    failed = [
                        (child, code) for child, code in failed if code is not None
                    ]
                    if failed:
                        for child, exit_code in failed:
                            report_child_exit(child.name, exit_code, category)
                        if len(failed) == 1 and failed[0][0].name == "home":
                            raise HomeExited(failed[0][1])
                        raise StartupError("Pool child exited before initial health")
                    operation_timeout(STARTUP_TIMEOUT_SECONDS)
                    if recovering and readiness.policy_fused():
                        raise StartupError("Policy fused during recovery")
                    services_ready = check_services(management_key, node_id)
                    readiness.set_ready(services_ready)
                    if services_ready and readiness.snapshot()[0]:
                        break
                    stop.wait(operation_timeout(0.5))
                if stop.is_set():
                    raise RecoveryCancelled()
                if not readiness.snapshot()[0]:
                    raise StartupError(
                        "Home and node did not become healthy before timeout"
                    )
            return node_id

        node_id = launch_generation()
        recovery = HomeRecovery()
        category = FailureCategory.RUNTIME
        while not stop.wait(2):
            observed_at = time.monotonic()
            failed = [(child, child.process.poll()) for child in children]
            failed = [(child, code) for child, code in failed if code is not None]
            if failed:
                readiness.set_ready(False)
                for child, exit_code in failed:
                    report_child_exit(child.name, exit_code, category)
                if len(failed) != 1 or failed[0][0].name != "home" or failed[0][1] != 1:
                    raise StartupError("Pool child exited unexpectedly")

                with recovery.episode(stop, started_at=observed_at) as episode:
                    try:
                        drain_exited_home(failed[0][0])
                        readiness.begin_recovery()
                        while True:
                            terminate_children(children)
                            children.clear()
                            episode.before_launch()
                            try:
                                node_id = launch_generation(recovering=True)
                            except HomeExited as error:
                                if error.exit_code != 1:
                                    raise
                                drain_exited_home(children[0])
                                readiness.begin_recovery()
                                continue
                            episode.recovered()
                            break
                    except BaseException:
                        # Retain the absolute episode deadline through terminal cleanup.
                        readiness.set_ready(False)
                        stop.set()
                        try:
                            terminate_children(children)
                        finally:
                            recovery_cleanup_done = True
                            if policy_monitor_thread is not None:
                                policy_monitor_thread.join(
                                    timeout=episode.deadline.cleanup_remaining(1)
                                )
                            if ready_server is not None:
                                # shutdown() can block for a server poll. Stop it on a bounded worker.
                                shutdown = threading.Thread(
                                    target=ready_server.shutdown, daemon=True
                                )
                                shutdown.start()
                                shutdown.join(
                                    timeout=episode.deadline.cleanup_remaining(1)
                                )
                                ready_server.server_close()
                        raise
                continue
            readiness.set_ready(check_services(management_key, node_id))
        return 0
    except RecoveryCancelled:
        return 0
    except Exception:
        report_failure(category)
        return 1
    finally:
        if readiness is not None:
            readiness.set_ready(False)
        stop.set()
        if not recovery_cleanup_done and policy_monitor_thread is not None:
            policy_monitor_thread.join(timeout=1)
        if not recovery_cleanup_done and ready_server is not None:
            ready_server.shutdown()
            ready_server.server_close()
        if not recovery_cleanup_done:
            terminate_children(children)
        (ROOT / "bootstrap.yaml").unlink(missing_ok=True)
        (ROOT / "cluster.yaml").unlink(missing_ok=True)
        for signum, handler in original_signals.items():
            signal.signal(signum, handler)


if __name__ == "__main__":
    install_error_handlers()
    sys.exit(main())
