"""Local alone-proof for the route gateway: a scratch headscale tailnet, one exit node and a
stand-in echo service on the 203.0.113.0/24 test range, all on internal Docker networks.

  python3 containers/route-gateway/e2e/rig_test.py run [--evidence FILE]

Nothing here touches a real tailnet or Tailscale account. The same file also runs inside
the rig's containers as `echo` (the stand-in service) and `socks`/`watch` (the SOCKS
client standing in for the Durable Object).
"""

import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

TAILSCALE = "tailscale/tailscale@sha256:72c1e19e0aedca96b8533bbb0b4368564410ff20b17e53b804eb6c1f04a31be4"
HEADSCALE = "headscale/headscale@sha256:11f81665e842809db9fe3006a38c56a66e968baa5abd4bac498e86445572b970"  # v0.29.7
PYTHON = "python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337"
ECHO_IP, EXIT_IP, GATEWAY_IP = "203.0.113.10", "203.0.113.20", "203.0.113.30"
# The exit node resolves names through its DNS server, not /etc/hosts, so the name is a
# Docker alias on a network only the exit shares with echo; the gateway cannot resolve it.
ECHO_NAME, FAR_ECHO_IP, FAR_EXIT_IP = "echo.route-test.example", "198.51.100.10", "198.51.100.20"
HERE = os.path.dirname(os.path.abspath(__file__))
CONTEXT = os.path.dirname(HERE)


# --- inside the rig -------------------------------------------------------------------

def echo():
    import http.server

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            print(json.dumps({"from": self.client_address[0], "path": self.path}), flush=True)
            body = b"echo\n"
            self.send_response(200)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    class Server(http.server.ThreadingHTTPServer):
        def verify_request(self, request, client_address):
            # Every TCP accept is logged, so a bare handshake with no request is counted too.
            print(json.dumps({"accept": client_address[0]}), flush=True)
            return True

    Server(("0.0.0.0", 8080), Handler).serve_forever()


def socks(host, port, target, label, timeout=12.0):
    """One SOCKS5 no-auth CONNECT plus a GET; returns what the client saw."""
    began = time.monotonic()
    result = {"label": label}
    try:
        connection = socket.create_connection((host, port), timeout=timeout)
        connection.settimeout(timeout)
        connection.sendall(b"\x05\x01\x00")
        if connection.recv(2) != b"\x05\x00":
            raise ConnectionError("greeting")
        if target[0].replace(".", "").isdigit():
            address = b"\x01" + socket.inet_aton(target[0])
        else:
            address = b"\x03" + bytes([len(target[0])]) + target[0].encode()
        connection.sendall(b"\x05\x01\x00" + address + struct.pack(">H", target[1]))
        answer = connection.recv(10)
        result["reply"] = answer[1]
        if answer[1] == 0:
            connection.sendall(f"GET /{label} HTTP/1.0\r\nHost: echo\r\n\r\n".encode())
            result["http"] = connection.recv(64).split(b"\r\n")[0].decode()
        connection.close()
    except (OSError, ConnectionError) as error:
        result["error"] = type(error).__name__
    result["ms"] = round((time.monotonic() - began) * 1000, 1)
    return result


def watch(label):
    """Start a call every 250 ms until one is refused, then time ten more calls."""
    began, results, lock = time.monotonic(), [], threading.Lock()
    refused = threading.Event()

    def one(index):
        offset = time.monotonic() - began
        outcome = socks("gateway", 1080, (ECHO_IP, 8080), f"{label}-{index}")
        outcome["started_s"] = round(offset, 2)
        with lock:
            results.append(outcome)
        if outcome.get("reply") == 2:
            refused.set()

    index = 0
    while not refused.is_set() and time.monotonic() - began < 30:
        threading.Thread(target=one, args=(index,), daemon=True).start()
        index += 1
        refused.wait(0.25)
    first = min((r["started_s"] + r["ms"] / 1000 for r in results if r.get("reply") == 2), default=None)
    after = [socks("gateway", 1080, (ECHO_IP, 8080), f"{label}-after-{i}") for i in range(10)]
    return {"first_refusal_s": first and round(first, 2), "calls": sorted(results, key=lambda r: r["started_s"]), "after": after}


def storm(label, seconds, workers=20):
    """`workers` connections opening in a loop for `seconds`; counts what the clients saw."""
    began, outcomes, lock = time.monotonic(), {}, threading.Lock()

    def loop(worker):
        count = 0
        while time.monotonic() - began < seconds:
            outcome = socks("gateway", 1080, (ECHO_IP, 8080), f"{label}-{worker}-{count}", timeout=6)
            key = str(outcome.get("reply", outcome.get("error")))
            with lock:
                outcomes[key] = outcomes.get(key, 0) + 1
            count += 1

    threads = [threading.Thread(target=loop, args=(worker,)) for worker in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return {"workers": workers, "seconds": seconds, "replies": outcomes}


def control(method, path, body=None):
    request = urllib.request.Request(
        "http://gateway:8080" + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


# --- on the host ----------------------------------------------------------------------

class Rig:
    def __init__(self, run_id):
        self.id = run_id
        self.scratch = os.path.expanduser(f"~/Library/Caches/basalt-route-gateway-e2e/{run_id}")
        self.image = f"basalt-route-gateway:e2e-{run_id}"
        self.net_ctl, self.net_inet, self.net_far = f"rgw-ctl-{run_id}", f"rgw-inet-{run_id}", f"rgw-far-{run_id}"
        self.names = {name: f"rgw-{name}-{run_id}" for name in ("headscale", "exit", "echo", "gateway", "probe")}
        self.evidence = {"run": run_id, "checks": {}}

    def docker(self, *args, check=True, capture=True):
        done = subprocess.run(["docker", *args], capture_output=capture, text=True)
        if check and done.returncode != 0:
            raise RuntimeError(f"docker {args[0]} failed: {done.stderr.strip()[-300:]}")
        return done.stdout.strip() if capture else ""

    def headscale(self, *args):
        return self.docker("exec", self.names["headscale"], "headscale", *args)

    def probe(self, *args):
        return json.loads(self.docker("exec", self.names["probe"], "python3", "/e2e/rig_test.py", *args))

    def gateway_call(self, method, path, body=None):
        return self.probe("control", method, path, json.dumps(body))

    def echo_lines(self, accepts=False):
        out = self.docker("logs", self.names["echo"])
        lines = [json.loads(line) for line in out.splitlines() if line.startswith("{")]
        return [line for line in lines if ("accept" in line) == accepts]

    def refusals(self):
        out = self.docker("logs", self.names["gateway"])
        return [json.loads(line) for line in out.splitlines() if line.startswith("{")]

    def wait_for(self, predicate, timeout, what):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            value = predicate()
            if value:
                return value
            time.sleep(0.5)
        raise RuntimeError(f"timed out waiting for {what}")

    def setup(self):
        os.makedirs(self.scratch, mode=0o700, exist_ok=True)
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
             "-keyout", f"{self.scratch}/tls.key", "-out", f"{self.scratch}/tls.crt",
             "-subj", "/CN=headscale", "-addext", "subjectAltName=DNS:headscale",
             "-addext", "basicConstraints=critical,CA:TRUE"],
            check=True, capture_output=True,
        )
        os.chmod(f"{self.scratch}/tls.key", 0o644)  # headscale runs as another uid in its container
        self.docker("build", "--quiet", "--tag", self.image, CONTEXT)
        self.docker("network", "create", "--internal", self.net_ctl)
        self.docker("network", "create", "--internal", "--subnet", "203.0.113.0/24", self.net_inet)
        self.docker("network", "create", "--internal", "--subnet", "198.51.100.0/24", self.net_far)
        certs = f"{self.scratch}:/certs:ro"
        self.docker(
            "run", "-d", "--name", self.names["headscale"], "--network", self.net_ctl, "--network-alias", "headscale",
            "-v", f"{HERE}/headscale.yaml:/etc/headscale/config.yaml:ro", "-v", certs,
            "--tmpfs", "/var/lib/headscale", "--tmpfs", "/var/run/headscale", HEADSCALE, "serve",
        )
        self.wait_for(lambda: subprocess.run(["docker", "exec", self.names["headscale"], "headscale", "users", "list"],
                                             capture_output=True).returncode == 0, 30, "headscale")
        self.headscale("users", "create", "rig")
        user = next(u for u in json.loads(self.headscale("users", "list", "-o", "json")) if u["name"] == "rig")
        key = json.loads(self.headscale("preauthkeys", "create", "--user", str(user["id"]), "--expiration", "1h", "-o", "json"))["key"]
        self.docker(
            "run", "-d", "--name", self.names["echo"], "--network", self.net_inet, "--ip", ECHO_IP,
            "-v", f"{HERE}:/e2e:ro", PYTHON, "python3", "/e2e/rig_test.py", "echo",
        )
        self.docker("network", "connect", "--ip", FAR_ECHO_IP, "--alias", ECHO_NAME, self.net_far, self.names["echo"])
        self.docker("create", "--name", self.names["exit"], "--network", self.net_ctl,
                    "-v", certs, "-e", "SSL_CERT_FILE=/certs/tls.crt",
                    "--entrypoint", "sh", TAILSCALE, "-c",
                    "tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale --socket=/var/run/ts.sock & "
                    "sleep 1; tailscale --socket=/var/run/ts.sock up --login-server=https://headscale "
                    f"--authkey={key} --hostname=home-exit --advertise-exit-node --advertise-routes=203.0.113.0/24,198.51.100.0/24; wait")
        self.docker("network", "connect", "--ip", EXIT_IP, self.net_inet, self.names["exit"])
        self.docker("network", "connect", "--ip", FAR_EXIT_IP, self.net_far, self.names["exit"])
        self.docker("start", self.names["exit"])
        exit_node = self.wait_for(lambda: next((n for n in (json.loads(self.headscale("nodes", "list", "-o", "json")) or [])
                                                if n.get("given_name") == "home-exit" or n.get("name") == "home-exit"), None),
                                  60, "exit node registration")
        self.exit_node_id = str(exit_node["id"])
        self.headscale("nodes", "approve-routes", "--identifier", self.exit_node_id, "--routes", "0.0.0.0/0,::/0,203.0.113.0/24,198.51.100.0/24")
        self.docker("run", "-d", "--name", self.names["probe"], "--network", self.net_ctl, "-v", f"{HERE}:/e2e:ro",
                    "--entrypoint", "python3", self.image, "-c", "import time; time.sleep(86400)")
        self.start_gateway()

    def start_gateway(self):
        self.docker("create", "--name", self.names["gateway"], "--network", self.net_ctl, "--network-alias", "gateway",
                    "-v", f"{self.scratch}:/certs:ro", "-v", f"{HERE}:/e2e:ro",
                    "-e", "SSL_CERT_FILE=/certs/tls.crt", "-e", "ROUTE_GATEWAY_CONTROL_URL=https://headscale", self.image)
        self.docker("network", "connect", "--ip", GATEWAY_IP, self.net_inet, self.names["gateway"])
        self.docker("start", self.names["gateway"])
        self.wait_for(lambda: subprocess.run(["docker", "exec", self.names["probe"], "python3", "-c",
                                              "import socket; socket.create_connection(('gateway', 8080), 2)"],
                                             capture_output=True).returncode == 0, 30, "gateway ports")

    def status(self):
        return self.gateway_call("GET", "/status")[1]

    def wait_ready(self, timeout=60):
        return self.wait_for(lambda: (s := self.status())["state"] == "ready" and s, timeout, "route ready")

    def through(self, label, target=(ECHO_IP, 8080)):
        return self.probe("socks", "gateway", "1080", target[0], str(target[1]), label)

    def echo_from(self, label):
        return [line["from"] for line in self.echo_lines() if line["path"].lstrip("/").startswith(label)]

    def record(self, name, passed, **details):
        self.evidence["checks"][name] = {"passed": bool(passed), **details}
        print(json.dumps({name: "PASS" if passed else "FAIL"}), flush=True)

    def run(self):
        code, started = self.gateway_call("POST", "/start", {"state": None})
        assert code == 200, started
        self.evidence["before_start_status"] = None

        # (4) logged out: refused with route_needs_login, nothing reaches echo.
        code, selected = self.gateway_call("POST", "/select", {"exit_id": "nPLACEHOLDER", "when_down": "stop"})
        logged_out = self.through("check4")
        reason = self.refusals()[-1] if self.refusals() else None
        self.record("4_logged_out", logged_out.get("reply") == 2 and reason == {"route_refused": "route_needs_login"}
                    and not self.echo_from("check4"), client=logged_out, gateway_log=reason, status=selected)

        code, login = self.gateway_call("POST", "/login")
        assert code == 200 and login.get("url"), login
        self.headscale("nodes", "register", "--user", "rig", "--key", login["url"].rstrip("/").rsplit("/", 1)[-1])
        self.wait_for(lambda: self.status()["node"]["logged_in"], 60, "login")
        exits = self.gateway_call("GET", "/exits")[1]["exits"]
        exit_id = next(item["id"] for item in exits if item["name"] == "home-exit")
        self.evidence["exits"] = exits
        self.gateway_call("POST", "/select", {"exit_id": exit_id, "when_down": "stop"})
        ready = self.wait_ready()
        self.evidence["ready_status"] = ready
        # What the per-connection check costs: status (with peers) plus prefs, 200 times.
        self.evidence["check_read_ms"] = json.loads(self.docker("exec", self.names["gateway"], "python3", "-c", (
            "import asyncio, json, statistics, time, adapter_tailscale as a\n"
            "async def main():\n"
            "    adapter, samples = a.TailscaleAdapter(), []\n"
            "    for _ in range(200):\n"
            "        began = time.perf_counter(); await adapter.snapshot(); samples.append((time.perf_counter() - began) * 1000)\n"
            "    samples.sort(); print(json.dumps({'median': round(statistics.median(samples), 2), 'p95': round(samples[189], 2), 'max': round(samples[-1], 2), 'peers': 1}))\n"
            "asyncio.run(main())")))

        # (1) routed: echo sees the exit's address.
        routed = self.through("check1")
        self.record("1_routed", routed.get("reply") == 0 and self.echo_from("check1") == [EXIT_IP],
                    client=routed, echo_saw=self.echo_from("check1"))

        # (7) a DOMAIN target resolves on the exit side; the gateway itself cannot resolve it.
        local = subprocess.run(["docker", "exec", self.names["gateway"], "python3", "-c",
                                f"import socket; socket.getaddrinfo('{ECHO_NAME}', 8080)"], capture_output=True)
        domain = self.through("check7", (ECHO_NAME, 8080))
        self.record("7_domain_on_exit", domain.get("reply") == 0 and self.echo_from("check7") == [FAR_EXIT_IP]
                    and local.returncode != 0, client=domain, echo_saw=self.echo_from("check7"),
                    gateway_resolves_name=local.returncode == 0)

        # (5) state survives a killed container with no new approval.
        code, saved = self.gateway_call("GET", "/state")
        self.docker("rm", "-f", self.names["gateway"])
        self.start_gateway()
        self.gateway_call("POST", "/start", {"state": saved["state"]})
        self.gateway_call("POST", "/select", {"exit_id": exit_id, "when_down": "stop"})
        restored = self.wait_ready()
        after_restart = self.through("check5")
        self.record("5_state_restore", restored["node"]["logged_in"] and after_restart.get("reply") == 0
                    and self.echo_from("check5") == [EXIT_IP], status=restored, client=after_restart)

        # (2) frozen exit: control still says online; only the ping catches it.
        self.docker("pause", self.names["exit"])
        frozen = self.probe("watch", "check2")
        reasons = [r.get("route_refused") for r in self.refusals() if "route_refused" in r]
        after_ms = [call["ms"] for call in frozen["after"]]
        self.record("2_frozen_exit", frozen["first_refusal_s"] is not None and frozen["first_refusal_s"] <= 8
                    and all(c.get("reply") == 2 for c in frozen["after"]) and max(after_ms) <= 50
                    and reasons[-1] == "route_exit_unreachable",
                    first_refusal_s=frozen["first_refusal_s"], after_ms=after_ms, last_reason=reasons[-1],
                    calls=frozen["calls"])

        # (6) when_down=direct: echo sees the gateway's own address, status says direct_fallback.
        code, direct_status = self.gateway_call("POST", "/select", {"exit_id": exit_id, "when_down": "direct"})
        direct = self.through("check6")
        self.record("6_direct_fallback", direct.get("reply") == 0 and self.echo_from("check6") == [GATEWAY_IP]
                    and direct_status["state"] == "direct_fallback", client=direct, status=direct_status,
                    echo_saw=self.echo_from("check6"))
        self.gateway_call("POST", "/select", {"exit_id": exit_id, "when_down": "stop"})
        self.docker("unpause", self.names["exit"])
        self.wait_ready()

        # (3) exit removed from control: refused with route_exit_missing, echo gets nothing,
        # while tailscaled's raw proxy already sends the same call direct.
        accepts_before = self.echo_lines(accepts=True)
        load = subprocess.Popen(["docker", "exec", self.names["probe"], "python3", "/e2e/rig_test.py", "storm", "check3", "15"],
                                stdout=subprocess.PIPE, text=True)
        time.sleep(3)
        self.headscale("nodes", "delete", "--identifier", self.exit_node_id, "--force")
        under_load = json.loads(load.communicate(timeout=60)[0])
        direct_requests = [line for line in self.echo_lines() if line["path"].startswith("/check3") and line["from"] == GATEWAY_IP]
        bare_handshakes = sum(1 for line in self.echo_lines(accepts=True)[len(accepts_before):] if line["accept"] == GATEWAY_IP)
        missing = self.wait_for(lambda: (r := self.through("check3")).get("reply") == 2
                                and self.refusals()[-1] == {"route_refused": "route_exit_missing"} and r, 30,
                                "exit missing")
        raw = json.loads(self.docker("exec", self.names["gateway"], "python3", "/e2e/rig_test.py", "socks",
                                     "127.0.0.1", "1055", ECHO_IP, "8080", "raw-proxy"))
        # Calls may still reach echo through the exit until the netmap drops it; none may go direct.
        self.record("3_exit_removed", GATEWAY_IP not in self.echo_from("check3") and not direct_requests, client=missing,
                    under_load=under_load, direct_requests_from_gateway=len(direct_requests),
                    bare_handshakes_from_gateway=bare_handshakes,
                    routed_requests_during_load=sum(1 for ip in self.echo_from("check3") if ip == EXIT_IP),
                    gateway_log=self.refusals()[-1], raw_tailscaled_proxy=raw, raw_echo_saw=self.echo_from("raw-proxy"))
        self.evidence["final_status"] = self.status()

        # Logout leaves the tailnet and discards the identity: the next /state is a fresh node.
        before = self.gateway_call("GET", "/state")[1]["state"]
        logged_out = self.gateway_call("POST", "/logout")
        after_status = self.status()
        after = self.gateway_call("GET", "/state")[1]["state"]
        self.evidence["logout"] = {"response": logged_out, "status": after_status, "state_changed": before != after,
                                   "still_registered": self.headscale("nodes", "list", "-o", "json").count("signalbox-route")}

    def teardown(self):
        removed = {"containers": 0, "networks": 0, "images": 0}
        for name in self.names.values():
            if subprocess.run(["docker", "rm", "-f", name], capture_output=True).returncode == 0:
                removed["containers"] += 1
        for network in (self.net_far, self.net_inet, self.net_ctl):
            if subprocess.run(["docker", "network", "rm", network], capture_output=True).returncode == 0:
                removed["networks"] += 1
        if subprocess.run(["docker", "rmi", "-f", self.image], capture_output=True).returncode == 0:
            removed["images"] += 1
        for name in ("tls.key", "tls.crt"):
            try:
                os.remove(f"{self.scratch}/{name}")
            except FileNotFoundError:
                pass
        try:
            os.rmdir(self.scratch)
        except OSError:
            pass
        left = subprocess.run(["docker", "ps", "-a", "--filter", f"name=rgw-.*-{self.id}", "-q"],
                              capture_output=True, text=True).stdout.split()
        self.evidence["teardown"] = {**removed, "containers_left": len(left)}


def main(argv):
    command = argv[1] if len(argv) > 1 else "run"
    if command == "echo":
        return echo()
    if command == "socks":
        print(json.dumps(socks(argv[2], int(argv[3]), (argv[4], int(argv[5])), argv[6])))
        return 0
    if command == "storm":
        print(json.dumps(storm(argv[2], float(argv[3]))))
        return 0
    if command == "watch":
        print(json.dumps(watch(argv[2])))
        return 0
    if command == "control":
        body = json.loads(argv[4]) if len(argv) > 4 else None
        print(json.dumps(control(argv[2], argv[3], body)))
        return 0
    evidence_path = argv[argv.index("--evidence") + 1] if "--evidence" in argv else None
    rig = Rig(time.strftime("%Y%m%d%H%M%S"))
    try:
        rig.setup()
        rig.run()
    except Exception as error:
        rig.evidence["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        try:
            rig.evidence["gateway_log"] = rig.refusals()
        except Exception:
            pass
        if os.environ.get("RIG_KEEP") == "1":
            rig.evidence["teardown"] = {"kept": rig.id}
        else:
            rig.teardown()
        text = json.dumps(rig.evidence, indent=2)
        if evidence_path:
            with open(evidence_path, "w") as handle:
                handle.write(text + "\n")
        passed = rig.evidence["checks"]
        print(json.dumps({"passed": sum(c["passed"] for c in passed.values()), "of": 7, "teardown": rig.evidence["teardown"]}))
    return 0 if len(passed) == 7 and all(c["passed"] for c in passed.values()) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
