"""The private HTTP check observes native admission without renewing any lease."""

from __future__ import annotations

import http.client
import http.server
import json
import threading
import unittest
from typing import cast
from unittest.mock import patch

from . import policy_check, readiness


class PassivePolicyCheckTests(unittest.TestCase):
    def test_authenticated_check_is_read_only_and_does_not_restore_readiness(self) -> None:
        state = readiness.Readiness("management-fixture")
        handler = type("Handler", (readiness.ReadyHandler,), {"readiness": state})
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 1)
        self.addCleanup(server.shutdown)
        host, port = cast(tuple[str, int], server.server_address)

        def request(key: str) -> tuple[int, bytes]:
            connection = http.client.HTTPConnection(host, port, timeout=1)
            connection.request("POST", "/native-policy/check", body=json.dumps({"assertion": "signed-fixture"}),
                               headers={"Authorization": f"Bearer {key}"})
            response = connection.getresponse()
            result = (response.status, response.read())
            connection.close()
            return result

        with patch.object(policy_check, "native_policy_request", return_value=(200, {"ok": True})) as native:
            self.assertEqual(request("wrong")[0], 401)
            native.assert_not_called()
            status, body = request("management-fixture")
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"ok": True})
            native.assert_called_once_with("/check", {"assertion": "signed-fixture"}, timeout=1.0)
            self.assertFalse(state.snapshot()[0])

    def test_invalid_input_and_unavailable_native_checks_never_expose_native_fields(self) -> None:
        with patch.object(policy_check, "native_policy_request", return_value=(503, {"error": "private details", "accounts": ["private-account"]})) as native:
            self.assertEqual(policy_check.check_policy(b'{"assertion":"fixture"}'), (503, {"ok": False}))
            native.reset_mock()
            for value in (b"{}", b"bad-json", b'{"assertion":1}', b'{"assertion":"fixture","extra":true}'):
                self.assertEqual(policy_check.check_policy(value), (400, {"ok": False}))
            native.assert_not_called()


if __name__ == "__main__":
    unittest.main()
