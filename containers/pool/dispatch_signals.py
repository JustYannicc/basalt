"""Accept only closed dispatch stages, durations and outcomes from child logs."""

from __future__ import annotations

import json
import re

STAGES = {
    "home": frozenset({"authenticate", "selection", "admission", "reply_write"}),
    "node": frozenset({"ping", "rpop"}),
}
OUTCOMES = frozenset({"ok", "error", "timeout", "cancelled"})
NODE_LOG_LINE = re.compile(
    r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] "
    r"\[[^\]\r\n]+\] \[info \] "
    r"(?:\[[^\]\r\n]+:\d+\] )?(?P<message>[^\r\n]*)"
)


def node_dispatch_message(line: str) -> str:
    candidate = line.strip()
    match = NODE_LOG_LINE.fullmatch(candidate)
    return match.group("message") if match is not None else candidate


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate dispatch field")
        result[key] = value
    return result


def dispatch_signal_line(name: str, message: str | None) -> str | None:
    if name not in STAGES or message is None or "\n" in message or "\r" in message:
        return None
    marker = f"POOL_{name.upper()}_DISPATCH_TIMING "
    if not message.startswith(marker):
        return None
    try:
        value = json.loads(message[len(marker):], object_pairs_hook=_unique_object)
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or set(value) != {"stage", "duration_ms", "outcome"}:
        return None
    if not isinstance(value["stage"], str) or value["stage"] not in STAGES[name]:
        return None
    if not isinstance(value["outcome"], str) or value["outcome"] not in OUTCOMES:
        return None
    if type(value["duration_ms"]) is not int or not 0 <= value["duration_ms"] <= 86_400_000:
        return None
    return marker + json.dumps(value, sort_keys=True, separators=(",", ":"))
