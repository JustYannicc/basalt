"""SOCKS5 in on port 1080; the only thing in the gateway that dials out.

tailscaled's own SOCKS5 proxy sends traffic direct whenever no exit node is active, so
every connection is checked here before anything is dialled (stop-when-down).
"""

import asyncio
import contextlib
import json
import struct
import time

import adapter_tailscale as adapter_module

FRESH_S = 6.0
PING_EVERY_S = 2.0
CONNECT_TIMEOUT_S = 10.0
HANDSHAKE_TIMEOUT_S = 10.0
ABORT_AFTER_S = 10.0
MAX_CONNECTIONS = 512

GRANTED, FAILURE, NOT_ALLOWED, COMMAND_UNSUPPORTED, ADDRESS_UNSUPPORTED = 0x00, 0x01, 0x02, 0x07, 0x08


def log(record):
    # Reason codes only: never destinations, device names or tailnet names.
    print(json.dumps(record), flush=True)


def route_check(started, snapshot, selection, alive, now):
    """The I1 route check, in its frozen order. Returns a reason code, or None to route."""
    exit_id = selection["exit_id"]
    if exit_id is None:
        return "route_off"
    if not started:
        return "route_needs_login"
    if snapshot is None:
        return "route_status_unavailable"
    if not snapshot.logged_in:
        return "route_key_expired" if snapshot.key_expired else "route_needs_login"
    reason = exit_check(snapshot, exit_id)
    if reason is not None:
        return reason
    alive_id, alive_at = alive
    if alive_id != snapshot.active.id or alive_at is None or now - alive_at > FRESH_S:
        return "route_exit_unreachable"
    return None


def exit_check(snapshot, exit_id):
    """Steps 3-5: the selected exit is preferred, in the netmap and reported online."""
    if snapshot.selected is None or snapshot.selected != exit_id:
        return "route_not_selected"
    active = snapshot.active
    if active is None or active.id != snapshot.selected:
        return "route_exit_missing"
    if not active.online:
        return "route_exit_offline"
    return None


def reply(code):
    return bytes([0x05, code, 0x00, 0x01]) + b"\x00" * 6


async def read_request(reader):
    """Read one SOCKS5 CONNECT request; returns (command, raw request bytes, (host, port))."""
    head = await reader.readexactly(4)
    version, command, _, kind = head
    if version != 0x05:
        raise ValueError("version")
    if kind == 0x01:
        raw_address = await reader.readexactly(4)
        host = ".".join(str(byte) for byte in raw_address)
    elif kind == 0x04:
        raw_address = await reader.readexactly(16)
        host = ":".join(raw_address[i : i + 2].hex() for i in range(0, 16, 2))
    elif kind == 0x03:
        length = await reader.readexactly(1)
        raw_address = length + await reader.readexactly(length[0])
        host = raw_address[1:].decode("idna")
    else:
        return command, None, None
    raw_port = await reader.readexactly(2)
    return command, head + raw_address + raw_port, (host, struct.unpack(">H", raw_port)[0])


async def read_reply(reader):
    head = await reader.readexactly(4)
    kind = head[3]
    size = {0x01: 4, 0x04: 16}.get(kind)
    if size is None:
        size = (await reader.readexactly(1))[0]
        head += bytes([size])
    return head + await reader.readexactly(size + 2)


async def splice(client, upstream):
    """Copy both ways. A clean EOF half-closes; an error on either side closes both, so a
    reset never leaves the other direction waiting with its connection slot held."""
    (client_reader, client_writer), (upstream_reader, upstream_writer) = client, upstream
    deadline = None

    def abort():
        for side in (client_writer, upstream_writer):
            # A transport that already flushed and closed has nothing left to abort.
            with contextlib.suppress(AttributeError, RuntimeError):
                side.transport.abort()

    async def pump(reader, writer):
        nonlocal deadline
        try:
            while data := await reader.read(65536):
                writer.write(data)
                await writer.drain()
            if writer.can_write_eof():
                writer.write_eof()
        except (ConnectionError, OSError):
            # close() still flushes what was already received, and holds the other side
            # open until it has; a peer that never reads it is aborted after the deadline.
            client_writer.close()
            upstream_writer.close()
            if deadline is None:
                deadline = asyncio.get_running_loop().call_later(ABORT_AFTER_S, abort)

    await asyncio.gather(pump(client_reader, upstream_writer), pump(upstream_reader, client_writer))
    upstream_writer.close()
    if deadline is not None:
        await asyncio.gather(client_writer.wait_closed(), upstream_writer.wait_closed(), return_exceptions=True)
        deadline.cancel()


class Forwarder:
    def __init__(self, adapter, upstream_port=adapter_module.SOCKS_PORT):
        self.adapter = adapter
        self.upstream_port = upstream_port
        self.started = False
        self.selection = {"exit_id": None, "when_down": "stop"}
        self.alive = (None, None)
        self.active = 0

    async def check(self):
        snapshot = None
        if self.started and self.selection["exit_id"] is not None:
            try:
                snapshot = await self.adapter.snapshot()
            except adapter_module.AdapterError:
                snapshot = None
        return route_check(self.started, snapshot, self.selection, self.alive, time.monotonic())

    async def recheck(self):
        try:
            snapshot = await self.adapter.snapshot()
        except adapter_module.AdapterError:
            return "route_status_unavailable"
        return exit_check(snapshot, self.selection["exit_id"])

    async def liveness(self):
        """Ping the active exit every 2 s; a pong within 6 s is what makes it reachable."""
        while True:
            began = time.monotonic()
            try:
                if self.started:
                    snapshot = await self.adapter.snapshot()
                    active = snapshot.active
                    if active and active.ip and await self.adapter.ping(active.ip):
                        self.alive = (active.id, time.monotonic())
            except adapter_module.AdapterError:
                pass
            await asyncio.sleep(max(0.0, PING_EVERY_S - (time.monotonic() - began)))

    async def handle(self, reader, writer):
        busy = self.active >= MAX_CONNECTIONS
        self.active += 1
        try:
            await self._handle(reader, writer, busy)
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, OSError, ValueError):
            pass
        finally:
            self.active -= 1
            writer.close()

    async def _handle(self, reader, writer, busy):
        async def greet():
            version, count = await reader.readexactly(2)
            methods = await reader.readexactly(count)
            if version != 0x05:
                raise ValueError("version")
            if 0x00 not in methods:
                writer.write(b"\x05\xff")
                raise ValueError("auth")
            writer.write(b"\x05\x00")
            return await read_request(reader)

        command, request, target = await asyncio.wait_for(greet(), HANDSHAKE_TIMEOUT_S)
        if busy:
            log({"forwarder_busy": True})
            writer.write(reply(FAILURE))
            return
        if command != 0x01:
            writer.write(reply(COMMAND_UNSUPPORTED))
            return
        if request is None:
            writer.write(reply(ADDRESS_UNSUPPORTED))
            return
        reason = await self.check()
        if reason is None:
            upstream = await self._through_route(request, writer)
        elif self.selection["when_down"] == "direct":
            upstream = await self._direct(target, writer)
        else:
            log({"route_refused": reason})
            writer.write(reply(NOT_ALLOWED))
            return
        if upstream is not None:
            await splice((reader, writer), upstream)

    async def _through_route(self, request, writer):
        """Hand the client's CONNECT, unchanged and unresolved, to tailscaled's SOCKS5."""
        upstream_writer = None
        try:
            async def dial():
                nonlocal upstream_writer
                upstream_reader, upstream_writer = await asyncio.open_connection("127.0.0.1", self.upstream_port)
                upstream_writer.write(b"\x05\x01\x00")
                if await upstream_reader.readexactly(2) != b"\x05\x00":
                    raise ConnectionError("upstream_auth")
                upstream_writer.write(request)
                return upstream_reader, await read_reply(upstream_reader)

            upstream_reader, answer = await asyncio.wait_for(dial(), CONNECT_TIMEOUT_S)
            if answer[1] != GRANTED:
                raise ConnectionError("upstream_refused")
        except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, OSError):
            if upstream_writer is not None:
                upstream_writer.close()
            log({"route_dial_failed": True})
            writer.write(reply(FAILURE))
            return None
        # The netmap can drop the exit between the check and tailscaled's dial, which then
        # goes direct. Checking again before the client may send anything limits that race
        # to a bare handshake: no request bytes ever leave from the gateway's address.
        reason = await self.recheck()
        if reason is not None:
            upstream_writer.close()
            log({"route_refused": reason})
            writer.write(reply(NOT_ALLOWED))
            return None
        writer.write(answer)
        return upstream_reader, upstream_writer

    async def _direct(self, target, writer):
        """when_down=direct: dial from the gateway's own address, as the person chose."""
        try:
            upstream = await asyncio.wait_for(asyncio.open_connection(*target), CONNECT_TIMEOUT_S)
        except (asyncio.TimeoutError, OSError):
            log({"route_dial_failed": True})
            writer.write(reply(FAILURE))
            return None
        writer.write(reply(GRANTED))
        return upstream
