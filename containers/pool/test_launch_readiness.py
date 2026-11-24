"""Launch identity is authenticated and never relaxes the policy health lease."""

import hashlib
import http.client
import http.server
import json
import select
import socket
import sys
import threading
import time
import unittest

from .readiness import Readiness, ReadyHandler, ReadyServer


class LaunchReadinessTests(unittest.TestCase):
    def test_http_proof_requires_authentication_and_live_policy_health(self) -> None:
        clock = [1_000_000_000]
        token = "a" * 64
        ready = Readiness("fixture", lambda: clock[0], launch_generation="7", launch_token=token)
        handler = type("Handler", (ReadyHandler,), {"readiness": ready})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)

        def request(key: str):
            client = http.client.HTTPConnection(*server.server_address, timeout=1)
            client.request("GET", "/ready", headers={"Authorization": f"Bearer {key}"})
            response = client.getresponse()
            result = response.status, dict(response.getheaders()), response.read()
            client.close()
            return result

        ready.set_ready(True)
        ready.refresh_policy_lease("b" * 32)
        status, headers, body = request("wrong")
        self.assertEqual(status, 401)
        self.assertNotIn("X-Signalbox-Launch-Generation", headers)
        status, headers, body = request("fixture")
        self.assertEqual(status, 200)
        self.assertEqual(headers["X-Signalbox-Launch-Generation"], "7")
        self.assertEqual(headers["X-Signalbox-Launch-Token-Sha256"], hashlib.sha256(token.encode()).hexdigest())
        # A ready answer records the flip that made it ready.
        self.assertEqual(set(json.loads(body)), {"boot_id", "started_at", "db_rtt_state", "flips", "last_flip"})
        self.assertNotIn(token.encode(), body)
        clock[0] += 1_500_000_000
        status, headers, _ = request("fixture")
        self.assertEqual(status, 503)
        self.assertNotIn("X-Signalbox-Launch-Generation", headers)

    def test_persistent_clients_are_told_to_close_every_control_response(self) -> None:
        ready = Readiness("fixture", lambda: 1_000_000_000)
        handler = type("Handler", (ReadyHandler,), {"readiness": ready})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)
        ready.refresh_policy_lease("b" * 32)
        client = http.client.HTTPConnection(*server.server_address, timeout=1)
        self.addCleanup(client.close)
        for method, path, key, healthy, expected in [
            ("GET", "/ready", "fixture", True, 200),
            ("GET", "/ready", "fixture", False, 503),
            ("GET", "/ready", "wrong", True, 401),
            ("GET", "/missing", "fixture", True, 404),
            ("POST", "/native-policy", "fixture", True, 400),
            ("POST", "/native-policy/check", "fixture", True, 400),
            ("POST", "/native-policy", "wrong", True, 401),
            ("POST", "/missing", "fixture", True, 404),
        ]:
            with self.subTest(method=method, path=path, status=expected):
                ready.set_ready(healthy)
                client.request(method, path, body="{}" if method == "POST" else None,
                               headers={"Authorization": f"Bearer {key}", "Connection": "keep-alive"})
                response = client.getresponse()
                body = response.read()
                self.assertEqual(response.status, expected)
                self.assertEqual(len(body), int(response.getheader("Content-Length")))
                self.assertEqual(response.getheader("Connection"), "close")
                self.assertTrue(response.will_close)
                self.assertIsNone(client.sock)

    def test_partial_or_malformed_launch_input_refuses_with_a_fixed_error(self) -> None:
        for generation, token in [("1", None), (None, "a" * 64), ("0", "a" * 64), ("01", "a" * 64), ("9007199254740992", "a" * 64), ("1", "secret")]:
            with self.subTest(generation=generation):
                with self.assertRaisesRegex(ValueError, "^Invalid pool launch identity$"):
                    Readiness("fixture", launch_generation=generation, launch_token=token)

    def test_legacy_readiness_and_home_boot_rotation_keep_their_existing_contract(self) -> None:
        self.assertEqual(Readiness("fixture").launch_headers(), {})
        ready = Readiness("fixture", launch_generation="2", launch_token="a" * 64)
        before = ready.generation()
        headers = ready.launch_headers()
        ready.home_process_restarted()
        self.assertNotEqual(ready.generation(), before)
        self.assertEqual(ready.launch_headers(), headers)
        self.assertFalse(ready.snapshot()[0])


class ReadinessRefusalTests(unittest.TestCase):
    """The 503 body names one closed reason; a fused or unproven policy outranks unhealthy services."""

    def readiness(self) -> tuple[Readiness, list[int]]:
        clock = [1_000_000_000]
        return Readiness("fixture-management-key", monotonic_ns=lambda: clock[0]), clock

    def test_reasons_in_order(self) -> None:
        ready, _ = self.readiness()
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_unproven")
        ready.enable_policy_observations()
        self.assertTrue(ready.refresh_policy_lease("a" * 32))
        self.assertEqual(ready.snapshot()[1]["refusal"], "degraded")
        ready.set_ready(True, audit_revision=ready.service_audit_revision())
        healthy, payload = ready.snapshot()
        self.assertTrue(healthy)
        self.assertNotIn("refusal", payload)
        ready.note_policy_fused(ready.policy_observation_generation())
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_fused")

    def test_a_fuse_before_the_first_lease_latches_onto_the_next_instance(self) -> None:
        ready, _ = self.readiness()
        ready.enable_policy_observations()
        ready.note_policy_fused(ready.policy_observation_generation())
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_fused")
        # The first instance seen after the fuse is the fused one: its probes cannot clear it.
        self.assertFalse(ready.refresh_policy_lease("a" * 32))
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_fused")
        self.assertFalse(ready.refresh_policy_lease("a" * 32))
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_fused")
        # A newly loaded instance proves the veto again; services still need their audit.
        self.assertTrue(ready.refresh_policy_lease("b" * 32))
        self.assertEqual(ready.snapshot()[1]["refusal"], "degraded")

    def test_a_fused_instance_stays_fused_until_another_instance_loads(self) -> None:
        ready, _ = self.readiness()
        ready.enable_policy_observations()
        self.assertTrue(ready.refresh_policy_lease("a" * 32))
        ready.set_ready(True, audit_revision=ready.service_audit_revision())
        ready.note_policy_fused(ready.policy_observation_generation())
        self.assertFalse(ready.refresh_policy_lease("a" * 32))
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_fused")
        self.assertTrue(ready.refresh_policy_lease("b" * 32))
        self.assertEqual(ready.snapshot()[1]["refusal"], "degraded")

    def test_an_expired_lease_is_unproven_even_with_healthy_services(self) -> None:
        ready, clock = self.readiness()
        ready.enable_policy_observations()
        self.assertTrue(ready.refresh_policy_lease("a" * 32))
        ready.set_ready(True, audit_revision=ready.service_audit_revision())
        clock[0] += 2_000_000_000
        self.assertEqual(ready.snapshot()[1]["refusal"], "policy_unproven")


class ReadyServerBacklogTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform.startswith("linux"), "Linux accept-queue semantics")
    def test_a_burst_of_connects_completes_before_anything_is_accepted(self) -> None:
        # Linux completes a handshake only while the listen backlog has room and drops the rest,
        # which then wait out SYN retransmits. Nothing accepts here, so the backlog alone decides
        # whether a burst of health reads connects at once.
        handler = type("Handler", (ReadyHandler,), {"readiness": Readiness("fixture")})
        server = ReadyServer(("127.0.0.1", 0), handler)
        self.addCleanup(server.server_close)
        clients = [socket.socket(socket.AF_INET, socket.SOCK_STREAM) for _ in range(64)]
        for client in clients:
            self.addCleanup(client.close)
            client.setblocking(False)
            client.connect_ex(server.server_address)
        pending = set(clients)
        deadline = time.monotonic() + 2
        while pending and time.monotonic() < deadline:
            _, writable, _ = select.select([], list(pending), [], max(0.0, deadline - time.monotonic()))
            for client in writable:
                self.assertEqual(client.getsockopt(socket.SOL_SOCKET, socket.SO_ERROR), 0)
                pending.discard(client)
        self.assertEqual(len(pending), 0, f"{len(pending)} of 64 connects still waiting for the backlog")
