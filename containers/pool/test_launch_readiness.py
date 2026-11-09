"""Launch identity is authenticated and never relaxes the policy health lease."""

import hashlib
import http.client
import http.server
import json
import threading
import unittest

from .readiness import Readiness, ReadyHandler


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
        self.assertEqual(set(json.loads(body)), {"boot_id", "started_at"})
        self.assertNotIn(token.encode(), body)
        clock[0] += 1_500_000_000
        status, headers, _ = request("fixture")
        self.assertEqual(status, 503)
        self.assertNotIn("X-Signalbox-Launch-Generation", headers)

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
