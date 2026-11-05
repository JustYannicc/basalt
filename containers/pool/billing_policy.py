"""Keep pool admission independent of API-equivalent price availability."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any


class BillingPolicyError(RuntimeError):
    pass


def provision_billing_policy(
    request: Callable[[str, dict[str, Any] | None], tuple[int, dict[str, Any]]],
) -> None:
    policy = json.loads(Path(__file__).with_name("billing-settings.json").read_text())
    if (
        not isinstance(policy, dict)
        or set(policy) != {"allow_unpriced_models"}
        or policy["allow_unpriced_models"] is not True
    ):
        raise BillingPolicyError("pool billing policy must allow unpriced models")
    status, settings = request("GET", None)
    if status != 200 or not isinstance(settings, dict):
        raise BillingPolicyError("Home billing settings could not be read")
    if "allow_unpriced_models" not in settings:
        # Home v1.1.6/v1.1.7 have no price-based admission gate or this setting.
        if set(settings) == {"service_tier_source", "report_timezone"} and all(
            isinstance(value, str) and value for value in settings.values()
        ):
            return
        raise BillingPolicyError("Home billing settings capability is unknown")
    if type(settings["allow_unpriced_models"]) is not bool:
        raise BillingPolicyError("Home unpriced-model policy is invalid")
    status, _ = request("PATCH", policy)
    if status != 200:
        raise BillingPolicyError("Home unpriced-model policy could not be applied")
    status, settings = request("GET", None)
    if (
        status != 200
        or not isinstance(settings, dict)
        or settings.get("allow_unpriced_models") is not True
    ):
        raise BillingPolicyError("Home unpriced-model policy was not retained")
