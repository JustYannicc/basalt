"""Bounded standard-library tests for bootstrap and readiness contracts."""

from __future__ import annotations

import io
import json
import threading
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from typing import Any, cast

from .pool_contract import (
    bootstrap_yaml,
    cluster_yaml,
    home_boot_requires_import,
    pool_config_patch,
)
from .readiness import Readiness
from .child_signals import (
    HOME_INIT_FAILURE_CATEGORIES,
    HOME_INIT_FAILURE_MARKER,
    HOME_MAINTENANCE_FAILURE_MARKER,
    MAX_HOME_SIGNAL_INTEGER,
    privacy_audit_line,
    safe_child_output_line,
)

from .supervisor import Child

class FakeStream:
    def __init__(self, lines: list[str]) -> None:
        self._lines = iter(lines)

    def readline(self, size: int) -> str:
        return next(self._lines, "")


class BootstrapContractTests(unittest.TestCase):
    def read_child_output(self, name: str, lines: list[str]) -> list[str]:
        child = object.__new__(Child)
        child.name = name
        child.config_empty = threading.Event()
        child.process = cast(Any, SimpleNamespace(stdout=FakeStream(lines)))
        captured = io.StringIO()
        with redirect_stdout(captured):
            child._read_output()
        return captured.getvalue().splitlines()

    def test_cluster_dsn_is_quoted_without_changing_uri_options(self) -> None:
        dsn = (
            "postgresql://pool:fixture@db.example/pool"
            "?sslmode=require&options=-c%20role%3Dbasalt_pool_owner"
        )
        line = next(
            item for item in cluster_yaml(dsn).splitlines() if "postgres_uri:" in item
        )
        self.assertEqual(json.loads(line.split(":", 1)[1].strip()), dsn)

    def test_bootstrap_import_requires_home_empty_config_diagnostic(self) -> None:
        self.assertTrue(home_boot_requires_import(1, True))
        self.assertFalse(home_boot_requires_import(1, False))
        self.assertFalse(home_boot_requires_import(0, True))
        self.assertFalse(home_boot_requires_import(None, True))

    def test_exchange_config_does_not_contain_credentials_or_management_key(self) -> None:
        config = bootstrap_yaml(False)
        self.assertIn("strategy: round-robin", config)
        self.assertIn("session-affinity: true", config)
        self.assertIn("session-affinity-ttl: 1h", config)
        self.assertIn("request-retry: 3", config)
        self.assertIn("max-retry-credentials: 0", config)
        self.assertIn("max-retry-interval: 30", config)
        self.assertNotIn("secret-key", config)
        self.assertNotIn("api-keys:", config)
        self.assertNotIn("auth-dir:", config)

    def test_restart_patch_leaves_credentials_and_keys_out(self) -> None:
        patch = pool_config_patch(False)
        self.assertEqual(patch["server"], {"port": 8317, "commercial-mode": True})
        self.assertEqual(patch["observability"]["logs"], {"request-log": False, "debug": False, "logging-to-file": False})
        self.assertEqual(patch["routing"], {
            "strategy": "round-robin",
            "session-affinity": True,
            "session-affinity-ttl": "1h",
            "retry": {"request-retry": 3, "max-retry-credentials": 0, "max-retry-interval": 30},
        })
        self.assertNotIn("api-keys", patch)
        self.assertNotIn("codex-api-key", patch)
        self.assertNotIn("secret-key", patch["management"])

    def test_child_logs_allow_only_audit_counts(self) -> None:
        self.assertIsNone(privacy_audit_line("node", "prompt=private auth=secret"))
        self.assertIsNone(privacy_audit_line("home", "upstream failure body=private"))
        audit: dict[str, object] = {"usage_rows": 5, "purged_rows": 5, "active_key_count": 1,
                 "matched_active_key_copies": 10, "deleted_key_count": 0, "unknown_key_count": 0}
        line = "POOL_PRIVACY_AUDIT " + json.dumps(audit)
        parsed = privacy_audit_line("home", line)
        assert parsed is not None
        self.assertEqual(json.loads(parsed.split(" ", 1)[1]), audit)
        wrapped = 'time="2026-10-29T12:00:00Z" level=info msg=' + json.dumps(line)
        parsed = privacy_audit_line("home", wrapped)
        assert parsed is not None
        self.assertEqual(json.loads(parsed.split(" ", 1)[1]), audit)
        audit["content"] = "private"
        self.assertIsNone(privacy_audit_line("home", "POOL_PRIVACY_AUDIT " + json.dumps(audit)))
        audit.pop("content")
        audit["active_key_ids"] = [2]
        self.assertIsNone(privacy_audit_line("home", "POOL_PRIVACY_AUDIT " + json.dumps(audit)))

    def test_read_output_forwards_raw_and_logrus_privacy_signals(self) -> None:
        audit = {
            "usage_rows": 5,
            "purged_rows": 4,
            "active_key_count": 1,
            "matched_active_key_copies": 10,
            "deleted_key_count": 0,
            "unknown_key_count": 0,
        }
        progress = {"batches": 2, "rows_updated": 7}
        retry = {"attempt": 3, "retry_after_seconds": 12}
        audit_message = "POOL_PRIVACY_AUDIT " + json.dumps(audit)
        retry_message = "POOL_PRIVACY_RETRY " + json.dumps(retry)
        text_wrapped = (
            'time="2026-10-29T12:00:00Z" level=info msg='
            + json.dumps(audit_message)
            + ' raw_token="text-token-sentinel"'
        )
        json_wrapped = json.dumps(
            {
                "time": "2026-10-29T12:00:00Z",
                "level": "info",
                "msg": retry_message,
                "provider_response": "json-content-sentinel",
                "raw_token": "json-token-sentinel",
            }
        )

        output = self.read_child_output(
            "home",
            [
                "POOL_PRIVACY_PROGRESS " + json.dumps(progress) + "\n",
                json_wrapped + "\n",
                text_wrapped + "\n",
            ],
        )

        self.assertEqual(
            output,
            [
                'POOL_PRIVACY_PROGRESS {"batches":2,"rows_updated":7}',
                'POOL_PRIVACY_RETRY {"attempt":3,"retry_after_seconds":12}',
                (
                    "POOL_PRIVACY_AUDIT "
                    '{"active_key_count":1,"deleted_key_count":0,'
                    '"matched_active_key_copies":10,"purged_rows":4,'
                    '"unknown_key_count":0,"usage_rows":5}'
                ),
            ],
        )
        joined = "\n".join(output)
        self.assertNotIn("sentinel", joined)

    def test_read_output_forwards_pinned_home_formatter_signals(self) -> None:
        messages = [
            'POOL_PRIVACY_PROGRESS {"batches":2,"rows_updated":7}',
            'POOL_PRIVACY_RETRY {"attempt":3,"retry_after_seconds":12}',
            (
                "POOL_PRIVACY_AUDIT "
                '{"active_key_count":1,"deleted_key_count":0,'
                '"matched_active_key_copies":10,"purged_rows":4,'
                '"unknown_key_count":0,"usage_rows":5}'
            ),
        ]
        # These columns match Home's LogFormatter, including its padded level
        # and optional caller. Only the projected message may reach stdout.
        for caller in ("", "[private-caller-sentinel.go:144] "):
            with self.subTest(caller=caller):
                lines = [
                    "[CLIProxyAPIHome] [2026-10-29 12:00:00] "
                    "[private-request-sentinel] [info ] " + caller + message + "\n"
                    for message in messages
                ]
                output = self.read_child_output("home", lines)
                self.assertEqual(output, messages)
                self.assertNotIn("sentinel", "\n".join(output))
                self.assertEqual(self.read_child_output("node", lines), [])

    def test_read_output_rejects_content_in_pinned_home_formatter(self) -> None:
        prefix = (
            "[CLIProxyAPIHome] [2026-10-29 12:00:00] "
            "[--------] [info ] [diagnostics_privacy_worker.go:144] "
        )
        valid = 'POOL_PRIVACY_RETRY {"attempt":3,"retry_after_seconds":12}'
        lines = [
            prefix + 'provider failure: private-body-sentinel\n',
            prefix + valid + ' error=private-token-sentinel\n',
            prefix + 'POOL_PRIVACY_RETRY {"attempt":3,"retry_after_seconds":12,"body":"private-body-sentinel"}\n',
            prefix + 'POOL_PRIVACY_RETRY {"attempt":3,"attempt":4,"retry_after_seconds":12}\n',
            prefix.replace("CLIProxyAPIHome", "CLIProxyAPINode") + valid + "\n",
            prefix.replace("[info ]", "[unknown]") + valid + "\n",
        ]
        self.assertEqual(self.read_child_output("home", lines), [])

    def test_read_output_rejects_untrusted_or_malformed_content(self) -> None:
        sentinel = "provider-content-sentinel raw-token-sentinel"
        invalid_lines = [
            f"provider error {sentinel}\n",
            (
                'POOL_PRIVACY_PROGRESS {"batches":1,"rows_updated":2,'
                f'"error":"{sentinel}"}}\n'
            ),
            'POOL_PRIVACY_PROGRESS {"batches":true,"rows_updated":2}\n',
            'POOL_PRIVACY_PROGRESS {"batches":1.0,"rows_updated":2}\n',
            'POOL_PRIVACY_RETRY {"attempt":"2","retry_after_seconds":4}\n',
            'POOL_PRIVACY_PROGRESS {"batches":1,"rows_updated":-2}\n',
            (
                'POOL_PRIVACY_PROGRESS {"batches":1,"batches":2,'
                '"rows_updated":2}\n'
            ),
            (
                'POOL_PRIVACY_RETRY {"attempt":1,'
                f'"error":"{sentinel}"}}\n'
            ),
            (
                'POOL_PRIVACY_AUDIT {"usage_rows":1,"purged_rows":0,'
                '"active_key_count":0,"matched_active_key_copies":0,'
                '"deleted_key_count":0,"unknown_key_count":0,'
                f'"token":"{sentinel}"}}\n'
            ),
            (
                '{"level":"error","msg":"POOL_PRIVACY_RETRY '
                '{\\"attempt\\":2,\\"retry_after_seconds\\":4,'
                f'\\"raw_token\\":\\"{sentinel}\\"}}",'
                f'"raw_token":"{sentinel}"}}\n'
            ),
        ]

        output = self.read_child_output("home", invalid_lines)

        self.assertEqual(output, [])
        self.assertNotIn(sentinel, "\n".join(output))
        self.assertIsNone(
            safe_child_output_line(
                "home",
                f'POOL_PRIVACY_PROGRESS {{"batches":1,"rows_updated":{MAX_HOME_SIGNAL_INTEGER + 1}}}',
            )
        )
        maximum = safe_child_output_line(
            "home",
            f'POOL_PRIVACY_PROGRESS {{"batches":{MAX_HOME_SIGNAL_INTEGER},"rows_updated":0}}',
        )
        self.assertIsNotNone(maximum)

    def test_read_output_maps_home_startup_errors_to_one_hot_counts(self) -> None:
        failures = {
            "database": "failed to open database: db-driver-sentinel",
            "runtime": "failed to init runtime: provider-error-sentinel",
            "listener": "failed to listen on 0.0.0.0:8327: address-sentinel",
            "cluster": "failed to initialize cluster coordinator: cluster-sentinel",
        }
        log_lines = [
            'time="2026-10-29T12:00:00Z" level=error msg='
            + json.dumps(message)
            + "\n"
            for message in failures.values()
        ]
        log_lines.extend(
            [
                'time="2026-10-29T12:00:00Z" level=error msg='
                + json.dumps("database config is empty; run with -import first")
                + "\n",
                'time="2026-10-29T12:00:00Z" level=error msg='
                + json.dumps("provider failed: arbitrary-error-sentinel")
                + "\n",
            ]
        )

        # Actual Home startup errors use its custom formatter too.
        log_lines.extend(
            "[CLIProxyAPIHome] [2026-10-29 12:00:00] [--------] "
            "[fatal] [main.go:380] " + message + " error=private-sentinel\n"
            for message in failures.values()
        )

        output = self.read_child_output("home", log_lines)

        self.assertEqual(len(output), 2 * len(failures))
        for line, expected_category in zip(output, [*failures, *failures]):
            self.assertTrue(line.startswith(HOME_INIT_FAILURE_MARKER))
            counts = json.loads(line[len(HOME_INIT_FAILURE_MARKER) :])
            self.assertEqual(set(counts), set(HOME_INIT_FAILURE_CATEGORIES))
            self.assertTrue(all(type(value) is int for value in counts.values()))
            self.assertEqual(counts[expected_category], 1)
            self.assertEqual(sum(counts.values()), 1)
        joined = "\n".join(output)
        self.assertNotIn("sentinel", joined)
        self.assertIsNone(
            safe_child_output_line(
                "node", 'time="..." level=error msg="failed to open database: x"'
            )
        )

    def test_read_output_maps_existing_backfill_failures_to_counts(self) -> None:
        failures = {
            "derived_columns": "usage derived-column backfill batch failed",
            "cache_read": "usage cache-read backfill batch failed",
            "token_accounting": "usage token accounting backfill batch failed",
        }
        for category, message in failures.items():
            with self.subTest(category=category):
                lines = [
                    "[CLIProxyAPIHome] [2026-10-29 12:00:00] "
                    "[private-request-sentinel] [warn ] [main.go:811] "
                    + message + " error=private-response-sentinel\n",
                    'time="2026-10-29T12:00:00Z" level=warning msg='
                    + json.dumps(message) + ' error="private-token-sentinel"\n',
                    json.dumps({"level": "warning", "msg": message,
                                "error": "private-content-sentinel"}) + "\n",
                ]
                counts = {name: int(name == category) for name in failures}
                expected = HOME_MAINTENANCE_FAILURE_MARKER + json.dumps(
                    counts, sort_keys=True, separators=(",", ":")
                )
                self.assertEqual(self.read_child_output("home", lines), [expected] * 3)
                self.assertEqual(self.read_child_output("node", lines), [])
                self.assertIsNone(safe_child_output_line("home", message + " private-content-sentinel"))
                self.assertIsNone(safe_child_output_line("home", "provider: " + message))
                self.assertIsNone(safe_child_output_line("home", message + "ish error=private-content-sentinel"))

    def test_readiness_payload_contains_only_boot_identity(self) -> None:
        readiness = Readiness("fixture-management-key")
        ready, payload = readiness.snapshot()
        self.assertFalse(ready)
        self.assertEqual(set(payload), {"boot_id", "started_at"})
        self.assertTrue(readiness.authorized("Bearer fixture-management-key"))
        self.assertFalse(readiness.authorized("Bearer wrong"))
        readiness.set_ready(True)
        ready, _ = readiness.snapshot()
        self.assertTrue(ready)


if __name__ == "__main__":
    unittest.main()
