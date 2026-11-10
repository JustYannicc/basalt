"""Read the installed native guard without refreshing policy or its health lease."""

from __future__ import annotations

import json
from typing import Any

from .pool_contract import native_policy_request


def check_policy(body: bytes) -> tuple[int, dict[str, Any]]:
    try:
        value = json.loads(body)
    except (ValueError, TypeError):
        return 400, {"ok": False}
    if (
        not isinstance(value, dict)
        or set(value) != {"assertion"}
        or not isinstance(value["assertion"], str)
        or not value["assertion"]
    ):
        return 400, {"ok": False}
    status, result = native_policy_request("/check", value, timeout=1.0)
    if status == 200 and result == {"ok": True}:
        return 200, {"ok": True}
    return 503, {"ok": False}
