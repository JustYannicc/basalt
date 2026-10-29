"""Bounded standard-library tests for bootstrap and readiness contracts."""

from __future__ import annotations

import json
import unittest

from .pool_contract import (
    bootstrap_yaml,
    cluster_yaml,
    home_boot_requires_import,
    pool_config_patch,
)
from .readiness import Readiness
from .supervisor import privacy_audit_line


class BootstrapContractTests(unittest.TestCase):
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

    def test_child_logs_allow_only_private_audit_counts_and_ids(self) -> None:
        self.assertIsNone(privacy_audit_line("node", "prompt=private auth=secret"))
        self.assertIsNone(privacy_audit_line("home", "upstream failure body=private"))
        audit: dict[str, object] = {"usage_rows": 5, "purged_rows": 5, "active_key_count": 1,
                 "deleted_key_count": 0, "unknown_key_count": 0, "active_key_ids": [2]}
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
        audit["active_key_ids"] = ["token"]
        self.assertIsNone(privacy_audit_line("home", "POOL_PRIVACY_AUDIT " + json.dumps(audit)))

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
