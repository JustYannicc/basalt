"""The gateway's entry point: the I1 control port (8080) and the SOCKS5 forwarder (1080).

Both ports are reachable only through the owning Durable Object. Responses may carry the
person's own tailnet and exit names; logs and errors carry reason codes only.
"""

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time

import adapter_tailscale as adapter_module
import forwarder as forwarder_module

CONTROL_PORT = 8080
SOCKS_PORT = 1080
MAX_BODY = 16 * 1024
MAX_HEADERS = 64
REVISION_EVERY_S = 2.0
STATUS_TEXT = {200: "OK", 400: "Bad Request", 404: "Not Found", 405: "Method Not Allowed", 409: "Conflict", 503: "Service Unavailable"}


class Refusal(Exception):
    def __init__(self, status, error):
        super().__init__(error)
        self.status, self.error = status, error


def fields(body, allowed, required=()):
    """Decode a JSON object body; unknown or missing fields are a bad request."""
    if not body.strip():
        value = {}
    else:
        try:
            value = json.loads(body)
        except ValueError:
            raise Refusal(400, "bad_request")
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise Refusal(400, "bad_request")
    return value


class Gateway:
    def __init__(self, adapter, forwarder):
        self.adapter, self.forwarder = adapter, forwarder
        self.boot_id = None
        self.revision = 0
        self.state_hash = None

    def observe_state(self):
        """state_revision goes up whenever tailscaled rewrites its state file."""
        digest = hashlib.sha256(self.adapter.read_state()).hexdigest()
        if digest != self.state_hash:
            if self.state_hash is not None:
                self.revision += 1
            self.state_hash = digest
        return self.revision

    async def status(self):
        try:
            snapshot = await self.adapter.snapshot()
        except adapter_module.AdapterError:
            snapshot = None
        selection = self.forwarder.selection
        reason = forwarder_module.route_check(True, snapshot, selection, self.forwarder.alive, time.monotonic())
        if reason is None:
            state = "ready"
        elif selection["when_down"] == "direct":
            state = "direct_fallback"
        elif reason == "route_needs_login":
            state = "needs_login"
        else:
            state = "down"
        chosen = None
        if snapshot is not None and selection["exit_id"] is not None:
            chosen = next((item for item in snapshot.exits if item.id == selection["exit_id"]), None)
        return {
            "boot_id": self.boot_id,
            "state": state,
            "reason": reason,
            "when_down": selection["when_down"],
            "exit": None
            if chosen is None
            else {
                "id": chosen.id,
                "name": chosen.name,
                "online": chosen.online,
                "path": chosen.path,
                "relay_region": chosen.relay_region,
            },
            "node": {
                "logged_in": bool(snapshot and snapshot.logged_in),
                "key_expiry": snapshot.key_expiry if snapshot else None,
                "tailnet": snapshot.tailnet if snapshot and snapshot.logged_in else None,
            },
            "state_revision": self.observe_state(),
        }

    async def route(self, method, path, body):
        routes = {
            "/start": ("POST", self.start),
            "/status": ("GET", self.get_status),
            "/login": ("POST", self.login),
            "/exits": ("GET", self.exits),
            "/select": ("POST", self.select),
            "/logout": ("POST", self.logout),
            "/state": ("GET", self.get_state),
        }
        if path not in routes:
            raise Refusal(404, "bad_request")
        expected, handler = routes[path]
        if method != expected:
            raise Refusal(405, "bad_request")
        if path != "/start" and self.boot_id is None:
            raise Refusal(409, "route_gateway_unavailable")
        try:
            return await handler(body)
        except adapter_module.AdapterError:
            raise Refusal(503, "route_status_unavailable")

    async def start(self, body):
        value = fields(body, ("state",), ("state",))
        if self.boot_id is not None:
            raise Refusal(409, "bad_request")
        state = value["state"]
        if state is not None and not isinstance(state, str):
            raise Refusal(400, "bad_request")
        try:
            blob = base64.b64decode(state, validate=True) if state else b""
        except ValueError:  # binascii.Error is a ValueError
            raise Refusal(400, "bad_request")
        self.boot_id = secrets.token_hex(16)
        self.state_hash = hashlib.sha256(blob).hexdigest()
        try:
            await self.adapter.start(blob or None)
        except adapter_module.AdapterError:
            self.boot_id = None
            raise
        self.forwarder.started = True
        return {"boot_id": self.boot_id}

    async def get_status(self, body):
        fields(body, ())
        return await self.status()

    async def login(self, body):
        fields(body, ())
        url = await self.adapter.login()
        # The approval URL is returned to the DO only; it is never logged.
        return {"state": "ready"} if url is None else {"url": url}

    async def exits(self, body):
        fields(body, ())
        snapshot = await self.adapter.snapshot()
        return {"exits": [{"id": item.id, "name": item.name, "online": item.online} for item in snapshot.exits]}

    async def select(self, body):
        value = fields(body, ("exit_id", "when_down"), ("exit_id", "when_down"))
        exit_id, when_down = value["exit_id"], value["when_down"]
        if exit_id is not None and (not isinstance(exit_id, str) or not exit_id):
            raise Refusal(400, "bad_request")
        if when_down not in ("stop", "direct"):
            raise Refusal(400, "bad_request")
        await self.adapter.select(exit_id)
        self.forwarder.selection = {"exit_id": exit_id, "when_down": when_down}
        return await self.status()

    async def logout(self, body):
        fields(body, ())
        await self.adapter.logout()
        self.forwarder.selection = {"exit_id": None, "when_down": self.forwarder.selection["when_down"]}
        self.forwarder.alive = (None, None)
        return {}

    async def get_state(self, body):
        fields(body, ())
        revision = self.observe_state()
        return {"state": base64.b64encode(self.adapter.read_state()).decode(), "state_revision": revision}

    async def serve(self, reader, writer):
        status, payload = 200, None
        try:
            method, path, body = await asyncio.wait_for(read_http(reader), 10)
            payload = await self.route(method, path, body)
        except Refusal as refusal:
            status, payload = refusal.status, {"error": refusal.error}
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, ValueError):
            status, payload = 400, {"error": "bad_request"}
        except (ConnectionError, OSError):
            writer.close()
            return
        data = json.dumps(payload).encode()
        writer.write(
            f"HTTP/1.1 {status} {STATUS_TEXT[status]}\r\nContent-Type: application/json\r\n"
            f"Content-Length: {len(data)}\r\nConnection: close\r\n\r\n".encode()
            + data
        )
        try:
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        writer.close()


async def read_http(reader):
    request_line = (await reader.readline()).decode("latin-1").rstrip("\r\n")
    method, target, version = request_line.split(" ")
    if not version.startswith("HTTP/1."):
        raise ValueError("version")
    length = 0
    for _ in range(MAX_HEADERS + 1):
        line = (await reader.readline()).decode("latin-1").rstrip("\r\n")
        if not line:
            break
        name, _, value = line.partition(":")
        if name.strip().lower() == "content-length":
            length = int(value.strip())
        if name.strip().lower() == "transfer-encoding":
            raise ValueError("transfer-encoding")
    else:
        raise ValueError("headers")
    if length < 0 or length > MAX_BODY:
        raise Refusal(400, "bad_request")
    return method, target.split("?", 1)[0], await reader.readexactly(length)


async def main():
    adapter = adapter_module.TailscaleAdapter()
    forwarder = forwarder_module.Forwarder(adapter)
    gateway = Gateway(adapter, forwarder)
    control = await asyncio.start_server(gateway.serve, "0.0.0.0", CONTROL_PORT, limit=MAX_BODY + 1024)
    socks = await asyncio.start_server(forwarder.handle, "0.0.0.0", SOCKS_PORT, backlog=forwarder_module.MAX_CONNECTIONS)
    tasks = [asyncio.create_task(forwarder.liveness())]

    async def revisions():
        while True:
            if gateway.boot_id is not None:
                gateway.observe_state()
            await asyncio.sleep(REVISION_EVERY_S)

    async def daemon_exit():
        # tailscaled gone means the route is gone: exit so the DO restarts the container.
        while adapter.process is None:
            await asyncio.sleep(0.5)
        await adapter.process.wait()
        forwarder_module.log({"route_gateway_exit": "tailscaled"})
        os._exit(1)

    tasks += [asyncio.create_task(revisions()), asyncio.create_task(daemon_exit())]
    async with control, socks:
        await asyncio.gather(*tasks)


if __name__ == "__main__":
    asyncio.run(main())
