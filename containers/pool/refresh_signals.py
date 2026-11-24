"""A provider's rejection of a credential refresh, projected onto closed fields.

Home (carry 0695) logs one line when a provider rejects a refresh and the credential is disabled,
and one when its stop-time drain gives up with refreshes still in flight.
Only an opaque credential reference and a closed reason leave the container, so an operator can
find the account that needs signing in again without the line carrying who it belongs to.
"""

from __future__ import annotations

import json
import re

from .quota_signals import ACCOUNT_REF

MARKER = "POOL_CREDENTIAL_REFRESH_REJECTED "
DRAIN_TIMEOUT_MARKER = "POOL_HOME_REFRESH_DRAIN_TIMEOUT "
MAX_IN_FLIGHT = (1 << 63) - 1
REASONS = frozenset(
    {"refresh_token_reused", "refresh_token_revoked", "refresh_token_expired", "invalid_grant", "unauthorized"}
)
REJECTED = re.compile(r"credential refresh rejected credential=(?P<ref>\S+) reason=(?P<reason>\S+)")
DRAIN_TIMEOUT = re.compile(r"credential refresh drain timed out in_flight=(?P<count>[0-9]{1,19})")


def refresh_signal_line(message: str | None) -> str | None:
    """A closed record for Home's refresh rejection or stop-drain timeout lines, else None."""
    rejection = refresh_rejection_line(message)
    if rejection is not None or message is None:
        return rejection
    # A drain that timed out means Home was stopped with a refresh still out: its token may be lost.
    match = DRAIN_TIMEOUT.fullmatch(message.strip())
    if match is None or int(match["count"]) > MAX_IN_FLIGHT:
        return None
    return DRAIN_TIMEOUT_MARKER + json.dumps({"in_flight": int(match["count"])}, separators=(",", ":"))


def refresh_rejection_line(message: str | None) -> str | None:
    if message is None:
        return None
    match = REJECTED.fullmatch(message.strip())
    if match is None or ACCOUNT_REF.fullmatch(match["ref"]) is None or match["reason"] not in REASONS:
        return None
    return MARKER + json.dumps({"account_ref": match["ref"], "reason": match["reason"]}, separators=(",", ":"))
