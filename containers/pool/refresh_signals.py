"""A provider's rejection of a credential refresh, projected onto closed fields.

Home (carry 0695) logs one line when a provider rejects a refresh and the credential is disabled.
Only an opaque credential reference and a closed reason leave the container, so an operator can
find the account that needs signing in again without the line carrying who it belongs to.
"""

from __future__ import annotations

import json
import re

from .quota_signals import ACCOUNT_REF

MARKER = "POOL_CREDENTIAL_REFRESH_REJECTED "
REASONS = frozenset(
    {"refresh_token_reused", "refresh_token_revoked", "refresh_token_expired", "invalid_grant", "unauthorized"}
)
REJECTED = re.compile(r"credential refresh rejected credential=(?P<ref>\S+) reason=(?P<reason>\S+)")


def refresh_rejection_line(message: str | None) -> str | None:
    if message is None:
        return None
    match = REJECTED.fullmatch(message.strip())
    if match is None or ACCOUNT_REF.fullmatch(match["ref"]) is None or match["reason"] not in REASONS:
        return None
    return MARKER + json.dumps({"account_ref": match["ref"], "reason": match["reason"]}, separators=(",", ":"))
