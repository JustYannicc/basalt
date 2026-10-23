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
        self.assertIn("request-retry: 3", config)
        self.assertNotIn("secret-key", config)
        self.assertNotIn("api-keys:", config)
        self.assertNotIn("auth-dir:", config)

    def test_restart_patch_leaves_credentials_and_keys_out(self) -> None:
        patch = pool_config_patch(False)
        self.assertEqual(patch["server"], {"port": 8317})
        self.assertEqual(patch["routing"]["strategy"], "round-robin")
        self.assertTrue(patch["routing"]["session-affinity"])
        self.assertNotIn("api-keys", patch)
        self.assertNotIn("codex-api-key", patch)
        self.assertNotIn("secret-key", patch["management"])

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
