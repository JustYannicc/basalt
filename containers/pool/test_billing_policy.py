"""Pool price availability cannot silently become an inference admission check."""

import unittest
from unittest.mock import Mock, patch

from . import pool_contract
from .billing_policy import BillingPolicyError, provision_billing_policy

LEGACY = {"service_tier_source": "request", "report_timezone": "UTC"}


class BillingPolicyTests(unittest.TestCase):
    def test_legacy_home_without_the_capability_is_not_patched(self):
        request = Mock(return_value=(200, LEGACY))
        provision_billing_policy(request)
        request.assert_called_once_with("GET", None)

    def test_new_home_gets_the_explicit_policy_and_persisted_readback(self):
        request = Mock(
            side_effect=[
                (200, {**LEGACY, "allow_unpriced_models": False}),
                (200, {**LEGACY, "allow_unpriced_models": True}),
                (200, {**LEGACY, "allow_unpriced_models": True}),
            ]
        )
        provision_billing_policy(request)
        self.assertEqual(
            [call.args for call in request.call_args_list],
            [
                ("GET", None),
                ("PATCH", {"allow_unpriced_models": True}),
                ("GET", None),
            ],
        )

    def test_a_successful_patch_does_not_replace_persisted_readback(self):
        for status, readback in (
            (200, {**LEGACY, "allow_unpriced_models": False}),
            (200, LEGACY),
            (200, {**LEGACY, "allow_unpriced_models": 1}),
            (503, {}),
        ):
            with self.subTest(status=status, readback=readback):
                request = Mock(
                    side_effect=[
                        (200, {**LEGACY, "allow_unpriced_models": False}),
                        (200, {"allow_unpriced_models": True}),
                        (status, readback),
                    ]
                )
                with self.assertRaisesRegex(BillingPolicyError, "not retained"):
                    provision_billing_policy(request)

    def test_failed_patch_refuses_to_continue(self):
        request = Mock(
            side_effect=[
                (200, {**LEGACY, "allow_unpriced_models": True}),
                (503, {}),
            ]
        )
        with self.assertRaisesRegex(BillingPolicyError, "could not be applied"):
            provision_billing_policy(request)
        self.assertEqual(request.call_count, 2)

    def test_failed_or_unknown_capability_is_not_treated_as_legacy(self):
        for status, settings in (
            (503, {}),
            (200, {}),
            (200, {**LEGACY, "model_source": "request"}),
            (200, {**LEGACY, "allow_unpriced_models": "true"}),
        ):
            with self.subTest(status=status, settings=settings):
                request = Mock(return_value=(status, settings))
                with self.assertRaises(BillingPolicyError):
                    provision_billing_policy(request)
                self.assertEqual(request.call_count, 1)

    def test_configuration_cannot_complete_when_billing_readback_fails(self):
        with (
            patch.object(
                pool_contract,
                "request_json",
                side_effect=[
                    (200, {}),
                    (200, {**LEGACY, "allow_unpriced_models": False}),
                    (200, {"allow_unpriced_models": True}),
                    (200, {**LEGACY, "allow_unpriced_models": False}),
                ],
            ),
            self.assertRaisesRegex(BillingPolicyError, "not retained"),
        ):
            pool_contract.apply_pool_config("fixture-management-key", False)
