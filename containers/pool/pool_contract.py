"""Configuration, management API, and readiness contract for the pool image."""

from __future__ import annotations

import json
import os
import pathlib
import tempfile
import urllib.error
import urllib.request
from typing import Any


HOME_URL = "http://127.0.0.1:8327"
NODE_URL = "http://127.0.0.1:8317"
READY_BIND = ("0.0.0.0", 8318)
NODE_NAME = "basalt-pool"
ROOT = pathlib.Path("/dev/shm/cliproxy-pool")
PATH_VALUE = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"


class StartupError(RuntimeError):
    pass


def env_required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise StartupError(f"required environment variable is missing: {name}")
    return value


def boolean_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None or not value.strip():
        return default
    lowered = value.strip().lower()
    if lowered in ("1", "true", "yes", "on"):
        return True
    if lowered in ("0", "false", "no", "off"):
        return False
    raise StartupError(f"{name} must be true or false")


def require_tmpfs(path: pathlib.Path) -> None:
    target = os.path.realpath(path)
    try:
        lines = pathlib.Path("/proc/self/mountinfo").read_text(
            encoding="utf-8"
        ).splitlines()
    except OSError as error:
        raise StartupError("cannot verify memory-backed secret storage") from error
    for line in lines:
        fields = line.split(" - ", 1)
        if len(fields) != 2:
            continue
        left, right = fields
        mount_fields = left.split()
        if len(mount_fields) < 5:
            continue
        mountpoint = mount_fields[4]
        for escaped, actual in (
            ("\\040", " "),
            ("\\011", "\t"),
            ("\\012", "\n"),
            ("\\134", "\\"),
        ):
            mountpoint = mountpoint.replace(escaped, actual)
        if mountpoint == target:
            if right.split()[0] == "tmpfs":
                return
            raise StartupError("/dev/shm is not a tmpfs mount")
    raise StartupError("/dev/shm tmpfs mount is required")


def atomic_write(path: pathlib.Path, content: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=".pool-", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def cluster_yaml(database_url: str) -> str:
    # A JSON-quoted scalar is valid YAML and preserves URI query/credential bytes.
    encoded_url = json.dumps(database_url)
    return (
        "pgsql:\n"
        f"  postgres_uri: {encoded_url}\n"
        "node:\n"
        "  external-ip: 127.0.0.1\n"
        "  external-port: 8327\n"
        "  port: 8327\n"
        "  heartbeat-interval: 5s\n"
        "  heartbeat-timeout: 20s\n"
        "  event-poll-interval: 3s\n"
    )


def bootstrap_yaml(allow_remote: bool) -> str:
    remote = "true" if allow_remote else "false"
    return (
        "config-version: 8\n"
        "server:\n"
        "  port: 8317\n"
        "  commercial-mode: true\n"
        "plugins:\n"
        "  enabled: true\n"
        "  dir: /opt/pool/plugins\n"
        "  configs:\n"
        "    gemini-cli:\n"
        "      enabled: true\n"
        "      load-in-home: true\n"
        "observability:\n"
        "  logs:\n"
        "    request-log: false\n"
        "    debug: false\n"
        "    logging-to-file: false\n"
        "management:\n"
        f"  allow-remote: {remote}\n"
        "routing:\n"
        "  strategy: round-robin\n"
        "  session-affinity: true\n"
        "  session-affinity-ttl: 1h\n"
        "  retry:\n"
        "    request-retry: 3\n"
        "    max-retry-credentials: 0\n"
        "    max-retry-interval: 30\n"
    )


def request_json(
    url: str,
    method: str,
    management_key: str,
    payload: dict[str, Any] | None = None,
    timeout: float = 3,
) -> tuple[int, dict[str, Any]]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    headers = {"X-Management-Key": management_key}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            data = response.read()
            return response.status, json.loads(data) if data else {}
    except urllib.error.HTTPError as error:
        data = error.read()
        try:
            parsed = json.loads(data) if data else {}
        except (ValueError, TypeError):
            parsed = {}
        return error.code, parsed
    except (OSError, ValueError, urllib.error.URLError):
        return 0, {}


def management_ready(management_key: str) -> bool:
    status, _ = request_json(
        f"{HOME_URL}/v8/management/config",
        "GET",
        management_key,
        timeout=2,
    )
    return status == 200


def child_environment(
    kind: str,
    management_key: str,
    home_jwt: str = "",
    node_boot_id: str = "",
) -> dict[str, str]:
    if kind == "node" and not node_boot_id:
        raise StartupError("the node requires a fresh boot identity")
    home_dir = ROOT / kind / node_boot_id if kind == "node" else ROOT / kind
    env = {
        "HOME": str(home_dir),
        "PATH": PATH_VALUE,
        "PYTHONUNBUFFERED": "1",
        # Native plugin shadow libraries need an executable mount. Auth/config paths stay in HOME.
        "TMPDIR": "/tmp",
        "TZ": "Etc/UTC",
        "CLIPROXY_DIAGNOSTICS_METADATA_ONLY": "1",
    }
    pathlib.Path(env["HOME"]).mkdir(mode=0o700, parents=True, exist_ok=True)
    if kind == "home":
        env["MANAGEMENT_PASSWORD"] = management_key
    else:
        env["HOME_JWT"] = home_jwt
    return env


def pool_config_patch(allow_remote: bool) -> dict[str, Any]:
    return {
        "server": {"port": 8317, "commercial-mode": True},
        "observability": {"logs": {"request-log": False, "debug": False, "logging-to-file": False}},
        "routing": {
            "strategy": "round-robin",
            "session-affinity": True,
            "session-affinity-ttl": "1h",
            "retry": {
                "request-retry": 3,
                "max-retry-credentials": 0,
                "max-retry-interval": 30,
            },
        },
        "management": {"allow-remote": allow_remote},
        "plugins": {
            "enabled": True,
            "dir": "/opt/pool/plugins",
            "configs": {"gemini-cli": {"enabled": True, "load-in-home": True}},
        },
    }


def apply_pool_config(management_key: str, allow_remote: bool) -> None:
    # PATCH changes only these fields; it does not replace credentials or API keys.
    status, _ = request_json(
        f"{HOME_URL}/v8/management/config",
        "PATCH",
        management_key,
        pool_config_patch(allow_remote),
        timeout=10,
    )
    if status != 200:
        raise StartupError(f"Home routing configuration failed (HTTP {status})")


def create_node_jwt(management_key: str) -> tuple[str, str]:
    status, payload = request_json(
        f"{HOME_URL}/v8/management/certificates/clients",
        "POST",
        management_key,
        {"node_name": NODE_NAME},
        timeout=10,
    )
    node_id = payload.get("id")
    home_jwt = payload.get("home_jwt")
    if (
        status not in (200, 201)
        or not isinstance(node_id, str)
        or not isinstance(home_jwt, str)
    ):
        raise StartupError(f"Home node enrollment failed (HTTP {status})")
    return node_id, home_jwt


def check_services(management_key: str, node_id: str) -> bool:
    node_status, node_payload = request_json(
        f"{NODE_URL}/healthz",
        "GET",
        management_key,
        timeout=2,
    )
    if node_status != 200 or node_payload.get("status") != "ok":
        return False
    home_status, home_payload = request_json(
        f"{HOME_URL}/v8/management/nodes",
        "GET",
        management_key,
        timeout=2,
    )
    if home_status != 200:
        return False
    nodes = home_payload.get("nodes")
    if not isinstance(nodes, list):
        return False
    return any(
        isinstance(node, dict)
        and node.get("node_id") == node_id
        and node.get("healthy") is True
        for node in nodes
    )


def home_boot_requires_import(exit_code: int | None, saw_empty_config: bool) -> bool:
    return exit_code is not None and exit_code != 0 and saw_empty_config


