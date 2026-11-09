"""Prove collector metadata reaches container stdout without quota values."""

import json
import unittest

from .child_signals import safe_child_output_line
from . import test_output_privacy

MARKER = "POOL_QUOTA_COLLECTION "


def event():
    return {"account_ref": "11111111-2222-4333-8444-555555555555",
            "provider": "claude", "probe_ok": True, "truncated": False,
            "responses": [{"source": "claude", "valid": True, "windows": [
                {"id": "five_hour", "seconds": 18000},
                {"id": "seven_day", "seconds": 604800}]}]}


class QuotaSignalsTests(unittest.TestCase):
    def test_actual_child_forwards_both_streams(self):
        helper = test_output_privacy.OutputPrivacyTests()
        message = MARKER + json.dumps(event())
        for stream in ("stdout", "stderr"):
            _, _, stdout, _ = helper.home_exit(
                [helper.home_log(message, "info ")], stream=stream)
            lines = [line for line in stdout.splitlines() if line.startswith(MARKER)]
            self.assertEqual(len(lines), 1)
            self.assertEqual(json.loads(lines[0][len(MARKER):]), event())

    def test_rejects_untrusted_fields_and_strings(self):
        mutations = [
            lambda e: e.update(token="private-token"),
            lambda e: e.update(account_ref="private@email.example"),
            lambda e: e.update(provider="private-provider"),
            lambda e: e["responses"][0]["windows"][0].update(used=42),
            lambda e: e["responses"][0]["windows"][0].update(id="private-token"),
            lambda e: e["responses"][0]["windows"][0].update(seconds=True),
            lambda e: e["responses"][0]["windows"][0].update(seconds=-1),
            lambda e: e["responses"][0].update(source="codex"),
        ]
        for mutate in mutations:
            e = event()
            mutate(e)
            self.assertIsNone(safe_child_output_line("home", MARKER + json.dumps(e)))
        text = MARKER + json.dumps(event())
        self.assertIsNone(safe_child_output_line("node", text))
        self.assertIsNone(safe_child_output_line("home", text + "\nprivate-token"))
        self.assertIsNone(safe_child_output_line("home", text.replace('"probe_ok": true', '"probe_ok": true,"probe_ok": false')))
