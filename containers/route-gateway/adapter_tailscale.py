"""Everything tailscaled-specific: the daemon, its LocalAPI and its state file.

The forwarder and the control port only see `Snapshot` and the adapter methods, so a
different route adapter can replace this module without touching them.
"""

import asyncio
import dataclasses
import datetime
import json
import os

STATE_DIR = "/dev/shm/route-gateway/ts"
SOCKET = STATE_DIR + "/tailscaled.sock"
STATE_FILE = STATE_DIR + "/tailscaled.state"
SOCKS_PORT = 1055
# Only the e2e rig sets this; production uses Tailscale's own coordination server.
CONTROL_URL = os.environ.get("ROUTE_GATEWAY_CONTROL_URL", "")
HOSTNAME = "signalbox-route"


class AdapterError(Exception):
    """tailscaled did not answer, or refused the call."""


@dataclasses.dataclass(frozen=True)
class Exit:
    id: str
    name: str
    online: bool
    ip: str | None = None
    path: str = "unknown"
    relay_region: str | None = None


@dataclasses.dataclass(frozen=True)
class Snapshot:
    logged_in: bool
    key_expiry: str | None
    key_expired: bool
    selected: str | None
    active: Exit | None
    exits: tuple[Exit, ...] = ()
    tailnet: str | None = None


def _expiry(value, now):
    if not value or value.startswith("0001-"):
        return None, False
    try:
        moment = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None, False
    return value, moment.timestamp() <= now


def _peer_exit(peer):
    ips = [ip.split("/")[0] for ip in peer.get("TailscaleIPs") or [] if "." in ip]
    relay = peer.get("Relay") or None
    path = "direct" if peer.get("CurAddr") else "relay" if relay else "unknown"
    name = (peer.get("DNSName") or "").split(".")[0] or peer.get("HostName") or ""
    return Exit(
        id=peer.get("ID") or "",
        name=name,
        online=bool(peer.get("Online")),
        ip=ips[0] if ips else None,
        path=path,
        relay_region=relay if path == "relay" else None,
    )


def parse_snapshot(status, prefs, now):
    """Normalise tailscaled's status and prefs JSON; pure, so tests drive it directly."""
    self_status = status.get("Self") or {}
    key_expiry, key_expired = _expiry(self_status.get("KeyExpiry"), now)
    peers = {peer.get("ID"): _peer_exit(peer) for peer in (status.get("Peer") or {}).values()}
    exits = tuple(
        peers[peer.get("ID")]
        for peer in (status.get("Peer") or {}).values()
        if peer.get("ExitNodeOption")
    )
    # tailscaled keeps reporting ExitNodeStatus, online, after control removes the exit from
    # the netmap, and its proxy then dials direct; only a peer still in the netmap counts.
    active = None
    exit_status = status.get("ExitNodeStatus")
    known = peers.get(exit_status.get("ID")) if exit_status else None
    if known:
        ips = [ip.split("/")[0] for ip in exit_status.get("TailscaleIPs") or [] if "." in ip]
        active = dataclasses.replace(known, online=bool(exit_status.get("Online")), ip=ips[0] if ips else known.ip)
    tailnet = (status.get("CurrentTailnet") or {}).get("Name") or None
    return Snapshot(
        logged_in=status.get("BackendState") in ("Running", "Starting"),
        key_expiry=key_expiry,
        key_expired=key_expired,
        selected=prefs.get("ExitNodeID") or None,
        active=active,
        exits=exits,
        tailnet=tailnet,
    )


async def _local_api(method, path, body=None, timeout=3.0):
    async def call():
        reader, writer = await asyncio.open_unix_connection(SOCKET)
        try:
            data = b"" if body is None else json.dumps(body).encode()
            head = (
                f"{method} {path} HTTP/1.0\r\nHost: local-tailscaled.sock\r\n"
                f"Sec-Tailscale: localapi\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(data)}\r\n\r\n"
            )
            writer.write(head.encode() + data)
            await writer.drain()
            raw = await reader.read()
        finally:
            writer.close()
        header, _, payload = raw.partition(b"\r\n\r\n")
        parts = header.split(b" ", 2)
        if len(parts) < 2 or not parts[1].isdigit() or int(parts[1]) >= 300:
            raise AdapterError("localapi_refused")
        return json.loads(payload) if payload.strip() else None

    try:
        return await asyncio.wait_for(call(), timeout)
    except (OSError, ValueError, asyncio.TimeoutError) as error:
        raise AdapterError("localapi_unavailable") from error


class TailscaleAdapter:
    def __init__(self):
        self.process = None

    async def start(self, state):
        os.makedirs(STATE_DIR, mode=0o700, exist_ok=True)
        if state:
            descriptor = os.open(STATE_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(state)
        # Output goes nowhere: tailscaled prints login URLs and device names.
        self.process = await asyncio.create_subprocess_exec(
            "tailscaled",
            "--tun=userspace-networking",
            "--statedir=" + STATE_DIR,
            "--state=" + STATE_FILE,
            "--socket=" + SOCKET,
            f"--socks5-server=127.0.0.1:{SOCKS_PORT}",
            "--no-logs-no-support",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
            env={**os.environ, "HOME": "/dev/shm/route-gateway", "TS_NO_LOGS_NO_SUPPORT": "true"},
        )
        for _ in range(150):
            try:
                await _local_api("GET", "/localapi/v0/status?peers=false", timeout=1.0)
                return
            except AdapterError:
                await asyncio.sleep(0.1)
        raise AdapterError("tailscaled_not_ready")

    async def snapshot(self):
        status = await _local_api("GET", "/localapi/v0/status")
        prefs = await _local_api("GET", "/localapi/v0/prefs")
        return parse_snapshot(status or {}, prefs or {}, datetime.datetime.now().timestamp())

    async def ping(self, ip):
        try:
            result = await _local_api("POST", f"/localapi/v0/ping?ip={ip}&type=disco", timeout=2.0)
        except AdapterError:
            return False
        return bool(result) and not result.get("Err")

    async def login(self):
        """Return Tailscale's approval URL, or None when the node is already signed in."""
        if (await self.snapshot()).logged_in:
            return None
        prefs = {"WantRunning": True, "LoggedOut": False, "Hostname": HOSTNAME}
        if CONTROL_URL:
            prefs["ControlURL"] = CONTROL_URL
        await _local_api("POST", "/localapi/v0/start", {"UpdatePrefs": prefs})
        await _local_api("POST", "/localapi/v0/login-interactive")
        for _ in range(100):
            status = await _local_api("GET", "/localapi/v0/status?peers=false")
            if status.get("AuthURL"):
                return status["AuthURL"]
            if status.get("BackendState") == "Running":
                return None
            await asyncio.sleep(0.1)
        raise AdapterError("login_url_unavailable")

    async def select(self, exit_id):
        await _local_api(
            "PATCH",
            "/localapi/v0/prefs",
            {"ExitNodeID": exit_id or "", "ExitNodeIDSet": True, "ExitNodeIP": "", "ExitNodeIPSet": True},
        )

    async def logout(self):
        await _local_api("POST", "/localapi/v0/logout", timeout=10.0)

    def read_state(self):
        try:
            with open(STATE_FILE, "rb") as handle:
                return handle.read()
        except FileNotFoundError:
            return b""
