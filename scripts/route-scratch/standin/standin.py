"""I1 stand-in for the P2 scratch run: control on 8080, SOCKS5 on 1080.

It never dials out. The only CONNECT target it accepts is echo.invalid:7, which it serves itself,
so the scratch Worker can never become an open proxy. A /login approves itself 5 s later.
"""
import asyncio
import base64
import json
import time
import uuid

STATE = {"boot": None, "state": None, "revision": 0, "selection": None, "login_at": None}


def logged_in():
    if STATE["state"] is None and STATE["login_at"] and time.time() - STATE["login_at"] >= 5:
        STATE["state"] = base64.b64encode(b"standin-node-" + uuid.uuid4().hex.encode()).decode()
        STATE["revision"] += 1
        STATE["login_at"] = None
    return STATE["state"] is not None


def status():
    signed_in = logged_in()
    selection = STATE["selection"] or {"exit_id": None, "when_down": "stop"}
    reason = None if signed_in and selection["exit_id"] else ("route_off" if signed_in else "route_needs_login")
    return {
        "boot_id": STATE["boot"],
        "state": "ready" if reason is None else ("needs_login" if not signed_in else "down"),
        "reason": reason,
        "when_down": selection["when_down"],
        "exit": {"id": selection["exit_id"], "name": "home-exit", "online": True, "path": "relay", "relay_region": "fra"}
        if signed_in and selection["exit_id"]
        else None,
        "node": {"logged_in": signed_in, "key_expiry": None, "tailnet": "example-tailnet" if signed_in else None},
        "state_revision": STATE["revision"],
    }


async def control(reader, writer):
    try:
        head = await reader.readuntil(b"\r\n\r\n")
        lines = head.decode().split("\r\n")
        method, path, _ = lines[0].split(" ")
        length = next((int(l.split(":")[1]) for l in lines if l.lower().startswith("content-length:")), 0)
        body = json.loads(await reader.readexactly(length)) if length else {}
        code, reply = 200, {}
        if path == "/start" and method == "POST":
            if STATE["boot"]:
                code, reply = 409, {"error": "route_gateway_unavailable"}
            else:
                STATE.update(boot=uuid.uuid4().hex, state=body.get("state"), revision=0)
                reply = {"boot_id": STATE["boot"]}
        elif not STATE["boot"]:
            code, reply = 409, {"error": "route_gateway_unavailable"}
        elif path == "/status":
            reply = status()
        elif path == "/login":
            if logged_in():
                reply = {"state": "ready"}
            else:
                STATE["login_at"] = STATE["login_at"] or time.time()
                reply = {"url": "https://login.example.invalid/a/test"}
        elif path == "/exits":
            reply = {"exits": [{"id": "n1", "name": "home-exit", "online": True}]}
        elif path == "/select":
            STATE["selection"] = {"exit_id": body.get("exit_id"), "when_down": body.get("when_down", "stop")}
            reply = status()
        elif path == "/logout":
            STATE.update(state=None, login_at=None)
            STATE["revision"] += 1
        elif path == "/state":
            reply = {"state": STATE["state"] or "", "state_revision": STATE["revision"]}
        else:
            code, reply = 400, {"error": "bad_request"}
        data = json.dumps(reply).encode()
        writer.write(
            f"HTTP/1.1 {code} X\r\ncontent-type: application/json\r\ncontent-length: {len(data)}\r\nconnection: close\r\n\r\n".encode()
            + data
        )
        await writer.drain()
    finally:
        writer.close()


async def socks(reader, writer):
    try:
        version, methods = await reader.readexactly(2)
        await reader.readexactly(methods)
        writer.write(b"\x05\x00")
        _, command, _, kind = await reader.readexactly(4)
        if kind == 3:
            host = (await reader.readexactly((await reader.readexactly(1))[0])).decode()
        else:
            host = None
            await reader.readexactly(4 if kind == 1 else 16)
        port = int.from_bytes(await reader.readexactly(2), "big")
        if not STATE["boot"] or not logged_in():
            writer.write(b"\x05\x02\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        if command != 1 or host != "echo.invalid" or port != 7:
            writer.write(b"\x05\x02\x00\x01\x00\x00\x00\x00\x00\x00")
            return
        writer.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
        writer.write_eof()
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        writer.close()


async def main():
    await asyncio.start_server(control, "0.0.0.0", 8080)
    await asyncio.start_server(socks, "0.0.0.0", 1080)
    await asyncio.Event().wait()


asyncio.run(main())
