import asyncio
import base64
import contextlib
import io
import json
import socket
import struct
import time
import unittest

import control
import forwarder
from adapter_tailscale import AdapterError, Exit, Snapshot, parse_snapshot

EXIT = Exit(id="nEXIT", name="home-exit", online=True, ip="100.64.0.3", path="direct")
READY = Snapshot(logged_in=True, key_expiry=None, key_expired=False, selected="nEXIT", active=EXIT, exits=(EXIT,), tailnet="example-tailnet", name="signalbox-route", node_id="nSELF")
SELECTED = {"exit_id": "nEXIT", "when_down": "stop"}


def check(snapshot=READY, selection=SELECTED, alive=("nEXIT", 100.0), now=101.0, started=True):
    return forwarder.route_check(started, snapshot, selection, alive, now)


def changed(**fields):
    return Snapshot(**{**READY.__dict__, **fields})


class RouteCheckTests(unittest.TestCase):
    def test_passes_when_every_step_holds(self):
        self.assertIsNone(check())

    def test_each_refusal_in_order(self):
        cases = [
            ("route_off", check(selection={"exit_id": None, "when_down": "stop"}, started=False, snapshot=None)),
            ("route_needs_login", check(started=False)),
            ("route_status_unavailable", check(snapshot=None)),
            ("route_key_expired", check(snapshot=changed(logged_in=False, key_expired=True))),
            ("route_needs_login", check(snapshot=changed(logged_in=False))),
            ("route_not_selected", check(snapshot=changed(selected=None))),
            ("route_not_selected", check(snapshot=changed(selected="nOTHER"))),
            ("route_exit_missing", check(snapshot=changed(active=None))),
            ("route_exit_missing", check(snapshot=changed(active=Exit(id="nOTHER", name="", online=True)))),
            ("route_exit_offline", check(snapshot=changed(active=Exit(id="nEXIT", name="", online=False)))),
            ("route_exit_unreachable", check(now=106.5)),
            ("route_exit_unreachable", check(alive=("nOTHER", 100.0))),
            ("route_exit_unreachable", check(alive=(None, None))),
        ]
        for expected, actual in cases:
            self.assertEqual(actual, expected)

    def test_earlier_steps_win_when_several_fail(self):
        everything_wrong = changed(logged_in=False, key_expired=True, selected=None, active=None)
        self.assertEqual(check(snapshot=everything_wrong, selection={"exit_id": None, "when_down": "stop"}), "route_off")
        self.assertEqual(check(snapshot=everything_wrong, started=False), "route_needs_login")
        self.assertEqual(check(snapshot=everything_wrong, alive=(None, None)), "route_key_expired")
        gone = changed(selected="nOTHER", active=Exit(id="nEXIT", name="", online=False))
        self.assertEqual(check(snapshot=gone, alive=(None, None)), "route_not_selected")
        offline_and_stale = changed(active=Exit(id="nEXIT", name="", online=False))
        self.assertEqual(check(snapshot=offline_and_stale, alive=(None, None)), "route_exit_offline")

    def test_a_running_node_is_not_refused_for_its_expiry_clock(self):
        self.assertIsNone(check(snapshot=changed(key_expired=True)))


class SnapshotTests(unittest.TestCase):
    def status(self, peers=True, **extra):
        peer = {"ID": "nEXIT", "HostName": "localhost", "DNSName": "home-exit.example-tailnet.ts.net.",
                "TailscaleIPs": ["100.64.0.3/32", "fd7a::3/128"], "Online": True, "ExitNodeOption": True,
                "CurAddr": "198.51.100.7:41641", "Relay": "fra"}
        return {"BackendState": "Running", "Self": {"ID": "nSELF", "KeyExpiry": "2999-01-01T00:00:00Z", "HostName": "signalbox-route"},
                "Peer": {"key": peer} if peers else None, "CurrentTailnet": {"Name": "example-tailnet"},
                "ExitNodeStatus": {"ID": "nEXIT", "Online": True, "TailscaleIPs": ["100.64.0.3/32"]}, **extra}

    def test_reads_exit_path_and_tailnet(self):
        snapshot = parse_snapshot(self.status(), {"ExitNodeID": "nEXIT"}, time.time())
        self.assertEqual(snapshot.active, Exit("nEXIT", "home-exit", True, "100.64.0.3", "direct", None, None))
        self.assertEqual((snapshot.name, snapshot.node_id), ("signalbox-route", "nSELF"))
        self.assertEqual(snapshot.tailnet, "example-tailnet")
        self.assertEqual(snapshot.exits[0].name, "home-exit")
        self.assertFalse(snapshot.key_expired)

    def test_an_offline_exit_reports_when_it_was_last_seen(self):
        status = self.status()
        status["Peer"]["key"].update(Online=False, LastSeen="2026-11-20T08:00:00Z")
        self.assertEqual(parse_snapshot(status, {}, time.time()).exits[0].last_seen, "2026-11-20T08:00:00Z")
        status["Peer"]["key"].update(Online=True)
        self.assertIsNone(parse_snapshot(status, {}, time.time()).exits[0].last_seen)

    def test_relay_only_reports_its_region(self):
        status = self.status()
        status["Peer"]["key"]["CurAddr"] = ""
        self.assertEqual(parse_snapshot(status, {}, time.time()).active.relay_region, "fra")

    def test_exit_that_stopped_offering_an_exit_route_is_missing(self):
        status = self.status()
        status["Peer"]["key"]["ExitNodeOption"] = False
        snapshot = parse_snapshot(status, {"ExitNodeID": "nEXIT"}, time.time())
        self.assertEqual(check(snapshot=snapshot), "route_exit_missing")

    def test_exit_gone_from_netmap_is_missing_even_while_reported_online(self):
        # Observed on 1.104.7: ExitNodeStatus stays online after control deletes the exit.
        snapshot = parse_snapshot(self.status(peers=False), {"ExitNodeID": "nEXIT"}, time.time())
        self.assertIsNone(snapshot.active)
        self.assertEqual(check(snapshot=snapshot), "route_exit_missing")

    def test_expired_key(self):
        status = self.status(BackendState="NeedsLogin", Self={"KeyExpiry": "2000-01-01T00:00:00Z"})
        snapshot = parse_snapshot(status, {"ExitNodeID": "nEXIT"}, time.time())
        self.assertTrue(snapshot.key_expired)
        self.assertFalse(snapshot.logged_in)


class FakeAdapter:
    def __init__(self, snapshot=READY):
        self.snapshot_value, self.state, self.selected, self.started_with = snapshot, b"state-1", [], None
        self.login_url = "https://login.example.invalid/a/test"
        self.start_error = None
        self.process = None

    async def snapshot(self):
        value = self.snapshot_value.pop(0) if isinstance(self.snapshot_value, list) else self.snapshot_value
        if isinstance(value, Exception):
            raise value
        return value

    async def start(self, state):
        if isinstance(self.start_error, Exception):
            raise self.start_error
        self.started_with = state

    async def ping(self, ip):
        return True

    async def login(self):
        return self.login_url

    async def select(self, exit_id):
        self.selected.append(exit_id)

    async def logout(self):
        self.state = b""

    def read_state(self):
        return self.state


class Upstream:
    """Stands in for tailscaled's SOCKS5: records each CONNECT and answers `code`."""

    def __init__(self, code=0):
        self.code, self.requests, self.relayed = code, [], []
        self.finished = asyncio.Event()

    async def handle(self, reader, writer):
        await reader.readexactly(3)
        writer.write(b"\x05\x00")
        head = await reader.readexactly(4)
        size = {1: 4, 4: 16}.get(head[3]) or (await reader.readexactly(1))[0]
        rest = await reader.readexactly(size + 2)
        self.requests.append(head + (bytes([size]) if head[3] == 3 else b"") + rest)
        writer.write(bytes([5, self.code, 0, 1]) + b"\x00" * 6)
        if self.code == 0:
            data = await reader.read(100)
            self.relayed.append(data)
            writer.write(data)
        writer.close()
        self.finished.set()


class ForwarderTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.upstream = Upstream()
        self.upstream_server = await asyncio.start_server(self.upstream.handle, "127.0.0.1", 0)
        self.adapter = FakeAdapter()
        self.forwarder = forwarder.Forwarder(self.adapter, upstream_port=self.upstream_server.sockets[0].getsockname()[1])
        self.forwarder.started = True
        self.forwarder.selection = dict(SELECTED)
        self.forwarder.alive = ("nEXIT", time.monotonic())
        self.server = await asyncio.start_server(self.forwarder.handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.log = io.StringIO()
        self.stdout = contextlib.redirect_stdout(self.log)
        self.stdout.__enter__()

    async def asyncTearDown(self):
        self.stdout.__exit__(None, None, None)
        for server in (self.server, self.upstream_server):
            server.close()
            # wait_closed also waits for open handlers; a failing test must not hang here.
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(server.wait_closed(), 2)

    async def socks(self, request, greeting=b"\x05\x01\x00", payload=b""):
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(greeting)
        method = await reader.readexactly(2)
        if method != b"\x05\x00":
            writer.close()
            return method, b""
        writer.write(request + payload)
        answer = await reader.read(10)
        rest = await asyncio.wait_for(reader.read(100), 2) if answer[1:2] == b"\x00" else b""
        writer.close()
        return answer, rest

    def records(self):
        return [json.loads(line) for line in self.log.getvalue().splitlines()]

    @staticmethod
    def ipv4(address="203.0.113.10", port=8080):
        return b"\x05\x01\x00\x01" + bytes(int(part) for part in address.split(".")) + struct.pack(">H", port)

    async def test_routed_connect_is_forwarded_unchanged_with_the_name_unresolved(self):
        request = b"\x05\x01\x00\x03\x17echo.route-test.example" + struct.pack(">H", 8080)
        answer, rest = await self.socks(request, payload=b"ping")
        self.assertEqual(answer[1], 0)
        self.assertEqual(rest, b"ping")
        self.assertEqual(self.upstream.requests, [request])

    async def test_exit_lost_during_the_dial_is_refused_before_any_payload(self):
        self.adapter.snapshot_value = [READY, changed(active=None)]
        answer, rest = await self.socks(self.ipv4(), payload=b"request-bytes")
        self.assertEqual((answer[1], rest), (0x02, b""))
        await asyncio.wait_for(self.upstream.finished.wait(), 2)
        self.assertEqual(len(self.upstream.requests), 1)
        self.assertEqual(self.upstream.relayed, [b""])
        self.assertEqual(self.records(), [{"route_refused": "route_exit_missing"}])

    async def test_exit_status_failure_during_the_dial_is_refused(self):
        self.adapter.snapshot_value = [READY, AdapterError("down")]
        answer, _ = await self.socks(self.ipv4(), payload=b"request-bytes")
        self.assertEqual(answer[1], 0x02)
        self.assertEqual(self.records(), [{"route_refused": "route_status_unavailable"}])

    async def test_an_upstream_reset_releases_the_connection(self):
        async def resetting(reader, writer):
            await reader.readexactly(3)
            writer.write(b"\x05\x00")
            await reader.readexactly(10)
            writer.write(b"\x05\x00\x00\x01" + b"\x00" * 6 + b"last-chunk")
            await writer.drain()
            # Linger 0 turns the close into a TCP reset, as a dropped far end would send.
            writer.get_extra_info("socket").setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            writer.transport.abort()

        server = await asyncio.start_server(resetting, "127.0.0.1", 0)
        self.forwarder.upstream_port = server.sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", self.port)
        writer.write(b"\x05\x01\x00" + self.ipv4())
        self.assertEqual((await reader.readexactly(12))[3], 0)
        # The client stays idle and open: only the forwarder can free the slot.
        self.assertIn(await asyncio.wait_for(reader.read(), 2), (b"last-chunk", b""))
        for _ in range(50):
            if self.forwarder.active == 0:
                break
            await asyncio.sleep(0.01)
        self.assertEqual(self.forwarder.active, 0)
        writer.close()
        server.close()

    async def test_stop_refuses_without_dialling(self):
        self.adapter.snapshot_value = changed(active=None)
        answer, _ = await self.socks(self.ipv4())
        self.assertEqual(answer[1], 0x02)
        self.assertEqual(self.upstream.requests, [])
        self.assertEqual(self.records(), [{"route_refused": "route_exit_missing"}])

    async def test_status_failure_refuses(self):
        self.adapter.snapshot_value = AdapterError("down")
        answer, _ = await self.socks(self.ipv4())
        self.assertEqual(answer[1], 0x02)
        self.assertEqual(self.records(), [{"route_refused": "route_status_unavailable"}])

    async def test_routing_off_refuses(self):
        self.forwarder.selection = {"exit_id": None, "when_down": "stop"}
        answer, _ = await self.socks(self.ipv4())
        self.assertEqual(answer[1], 0x02)
        self.assertEqual(self.records(), [{"route_refused": "route_off"}])

    async def test_direct_fallback_dials_the_target_itself(self):
        received = []

        async def target(reader, writer):
            received.append(await reader.read(4))
            writer.write(b"pong")
            writer.close()

        direct = await asyncio.start_server(target, "127.0.0.1", 0)
        self.forwarder.selection = {"exit_id": "nEXIT", "when_down": "direct"}
        self.adapter.snapshot_value = changed(active=Exit(id="nEXIT", name="", online=False))
        answer, rest = await self.socks(self.ipv4("127.0.0.1", direct.sockets[0].getsockname()[1]), payload=b"ping")
        direct.close()
        self.assertEqual((answer[1], rest, received), (0, b"pong", [b"ping"]))
        self.assertEqual(self.upstream.requests, [])

    async def test_upstream_refusal_is_a_dial_failure(self):
        self.upstream.code = 0x05
        answer, _ = await self.socks(self.ipv4())
        self.assertEqual(answer[1], 0x01)
        self.assertEqual(self.records(), [{"route_dial_failed": True}])

    async def test_only_connect_without_auth_is_accepted(self):
        bind = b"\x05\x02\x00\x01" + b"\x00" * 6
        self.assertEqual((await self.socks(bind))[0][1], 0x07)
        self.assertEqual((await self.socks(b"", greeting=b"\x05\x01\x02"))[0], b"\x05\xff")
        self.assertEqual((await self.socks(b"\x05\x01\x00\x09"))[0][1], 0x08)
        self.assertEqual(self.upstream.requests, [])

    async def test_past_the_connection_limit_answers_failure(self):
        self.forwarder.active = forwarder.MAX_CONNECTIONS
        answer, _ = await self.socks(self.ipv4())
        self.assertEqual(answer[1], 0x01)
        self.assertEqual(self.records(), [{"forwarder_busy": True}])
        self.assertEqual(self.upstream.requests, [])


class FakeProcess:
    def __init__(self):
        self.ended = asyncio.Event()

    async def wait(self):
        await self.ended.wait()


class WatcherTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_intended_restart_is_quiet_and_a_later_crash_exits(self):
        adapter, exits = FakeAdapter(), []
        adapter.process = first = FakeProcess()
        watcher = asyncio.create_task(control.watch_daemon(adapter, exits.append, idle_s=0.01))
        await asyncio.sleep(0.02)  # the watcher is now waiting on the first process
        with contextlib.redirect_stdout(io.StringIO()):
            adapter.process = second = FakeProcess()  # logout replaces tailscaled
            first.ended.set()
            await asyncio.sleep(0.05)
            self.assertEqual(exits, [])
            second.ended.set()
            await asyncio.wait_for(watcher, 1)
        self.assertEqual(exits, [1])


class StuckWriter:
    """A writer whose close() waits on a peer that never reads, until it is aborted."""

    def __init__(self, reader):
        self.reader, self.closed = reader, asyncio.Event()
        self.transport = self

    def write(self, data):
        pass

    async def drain(self):
        pass

    def can_write_eof(self):
        return False

    def close(self):
        pass

    def abort(self):
        self.reader.feed_eof()
        self.closed.set()

    async def wait_closed(self):
        await self.closed.wait()


class SpliceTests(unittest.IsolatedAsyncioTestCase):
    async def test_a_reset_frees_the_slot_even_when_the_client_never_reads(self):
        client_reader, upstream_reader = asyncio.StreamReader(), asyncio.StreamReader()
        upstream_reader.set_exception(ConnectionResetError())
        client_writer, upstream_writer = StuckWriter(client_reader), StuckWriter(upstream_reader)
        original, forwarder.ABORT_AFTER_S = forwarder.ABORT_AFTER_S, 0.1
        try:
            await asyncio.wait_for(forwarder.splice((client_reader, client_writer), (upstream_reader, upstream_writer)), 2)
        finally:
            forwarder.ABORT_AFTER_S = original
        self.assertTrue(client_writer.closed.is_set())


class ControlTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = FakeAdapter()
        self.forwarder = forwarder.Forwarder(self.adapter)
        self.gateway = control.Gateway(self.adapter, self.forwarder)

    async def call(self, method, path, body=b""):
        try:
            return 200, await self.gateway.route(method, path, body if isinstance(body, bytes) else json.dumps(body).encode())
        except control.Refusal as refusal:
            return refusal.status, {"error": refusal.error}

    async def start(self):
        state = base64.b64encode(b"state-1").decode()
        return await self.call("POST", "/start", {"state": state})

    async def test_everything_but_start_waits_for_start(self):
        for method, path in (("GET", "/status"), ("POST", "/login"), ("GET", "/exits"), ("GET", "/state"), ("POST", "/logout")):
            self.assertEqual(await self.call(method, path), (409, {"error": "route_gateway_unavailable"}))
        status, body = await self.start()
        self.assertEqual(status, 200)
        self.assertEqual(self.adapter.started_with, b"state-1")
        self.assertEqual((await self.start())[0], 409)
        self.assertEqual((await self.call("POST", "/start", b"not json"))[0], 409)

    async def test_a_failed_start_can_be_retried(self):
        self.adapter.start_error = PermissionError("shm")
        self.assertEqual(await self.start(), (503, {"error": "route_status_unavailable"}))
        self.assertFalse(self.forwarder.started)
        self.adapter.start_error = None
        self.assertEqual((await self.start())[0], 200)
        self.assertTrue(self.forwarder.started)

    async def test_bad_requests(self):
        self.assertEqual(await self.call("POST", "/start", {"state": None, "extra": 1}), (400, {"error": "bad_request"}))
        self.assertEqual(await self.call("POST", "/start", {"state": "not base64!"}), (400, {"error": "bad_request"}))
        self.assertEqual((await self.call("GET", "/start"))[0], 405)
        self.assertEqual((await self.call("GET", "/nothing"))[0], 404)
        await self.start()
        self.assertEqual((await self.call("POST", "/select", {"exit_id": "nEXIT"}))[0], 400)
        self.assertEqual((await self.call("POST", "/select", {"exit_id": "nEXIT", "when_down": "maybe"}))[0], 400)
        self.assertEqual((await self.call("POST", "/login", {"x": 1}))[0], 400)

    async def test_oversized_body_is_refused_before_reading_it(self):
        reader = asyncio.StreamReader()
        reader.feed_data(b"POST /start HTTP/1.1\r\nContent-Length: 16385\r\n\r\n")
        with self.assertRaises(control.Refusal):
            await control.read_http(reader)

    async def test_status_states(self):
        await self.start()
        await self.call("POST", "/select", {"exit_id": "nEXIT", "when_down": "stop"})
        self.forwarder.alive = ("nEXIT", time.monotonic())
        status = (await self.call("GET", "/status"))[1]
        self.assertEqual((status["state"], status["reason"]), ("ready", None))
        self.assertEqual(status["exit"], {"id": "nEXIT", "name": "home-exit", "online": True, "path": "direct", "relay_region": None})
        self.assertEqual(status["node"], {"logged_in": True, "key_expiry": None, "tailnet": "example-tailnet", "name": "signalbox-route", "id": "nSELF"})
        self.forwarder.alive = (None, None)
        self.assertEqual((await self.call("GET", "/status"))[1]["state"], "down")
        await self.call("POST", "/select", {"exit_id": "nEXIT", "when_down": "direct"})
        self.assertEqual((await self.call("GET", "/status"))[1]["state"], "direct_fallback")
        self.adapter.snapshot_value = changed(logged_in=False)
        await self.call("POST", "/select", {"exit_id": "nEXIT", "when_down": "stop"})
        status = (await self.call("GET", "/status"))[1]
        self.assertEqual((status["state"], status["reason"]), ("needs_login", "route_needs_login"))
        self.assertEqual((status["node"]["tailnet"], status["node"]["name"], status["node"]["id"]), (None, None, "nSELF"))
        await self.call("POST", "/select", {"exit_id": None, "when_down": "stop"})
        self.assertEqual((await self.call("GET", "/status"))[1]["reason"], "route_off")
        self.assertEqual(self.adapter.selected, ["nEXIT", "nEXIT", "nEXIT", None])

    async def test_login_and_state_revision(self):
        await self.start()
        self.assertEqual(await self.call("POST", "/login"), (200, {"url": self.adapter.login_url}))
        self.adapter.login_url = None
        self.assertEqual(await self.call("POST", "/login"), (200, {"state": "ready"}))
        self.assertEqual((await self.call("GET", "/state"))[1], {"state": base64.b64encode(b"state-1").decode(), "state_revision": 0})
        self.adapter.state = b"state-2"
        self.assertEqual((await self.call("GET", "/status"))[1]["state_revision"], 1)
        await self.call("POST", "/select", {"exit_id": "nEXIT", "when_down": "stop"})
        self.assertEqual((await self.call("POST", "/logout"))[1], {})
        self.adapter.snapshot_value = changed(logged_in=False, tailnet=None)
        status = (await self.call("GET", "/status"))[1]
        self.assertEqual((status["state"], status["reason"], status["state_revision"]), ("needs_login", "route_needs_login", 2))
        self.assertEqual((await self.call("GET", "/state"))[1]["state"], "")

    async def test_a_logout_whose_restart_fails_exits_the_container(self):
        exits = []
        self.gateway.exit = exits.append
        await self.start()

        async def broken_logout():
            self.adapter.process = None
            raise AdapterError("tailscaled_not_ready")

        self.adapter.logout = broken_logout
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual((await self.call("POST", "/logout"))[0], 503)
        self.assertEqual(exits, [1])

    async def test_a_logout_that_fails_before_stopping_tailscaled_is_retryable(self):
        exits = []
        self.gateway.exit = exits.append
        await self.start()
        self.adapter.process = FakeProcess()

        async def refused_logout():
            raise AdapterError("localapi_refused")

        self.adapter.logout = refused_logout
        self.assertEqual(await self.call("POST", "/logout"), (503, {"error": "route_status_unavailable"}))
        self.assertEqual(exits, [])

    async def test_adapter_failure_is_a_reason_code(self):
        await self.start()
        self.adapter.snapshot_value = AdapterError("down")
        self.assertEqual(await self.call("GET", "/exits"), (503, {"error": "route_status_unavailable"}))


if __name__ == "__main__":
    unittest.main()
