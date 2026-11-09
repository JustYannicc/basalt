"""Project only the collector's bounded account and returned-window metadata."""

from __future__ import annotations

import json
import re

MARKER = "POOL_QUOTA_COLLECTION "
PROVIDERS = {"codex", "claude", "antigravity", "kimi", "xai", "meta", "unknown"}
ACCOUNT_REF = re.compile(r"(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|sha256:[a-f0-9]{64})")
WINDOW_IDS = {
    "claude": re.compile(r"five_hour|seven_day(?:_oauth_apps|_opus|_sonnet|_cowork)?|iguana_necktie|extra_usage"),
    "codex": re.compile(r"(?:rate_limit|code_review_rate_limit|additional_rate_limits\[(?:[0-9]|[12][0-9]|3[01])\]\.rate_limit)\.(?:primary_window|secondary_window)"),
    "antigravity": re.compile(r"groups\[(?:[0-9]|[12][0-9]|3[01])\]\.buckets\[(?:[0-9]|[12][0-9]|3[01])\]"),
    "kimi": re.compile(r"usage|limits\[(?:[0-9]|[12][0-9]|3[01])\]"),
    "meta": re.compile(r"subs_usage\.(?:window|weekly)"),
    "xai-monthly": re.compile(r"config\.(?:currentPeriod|current_period|monthlyLimit|monthly_limit|creditUsagePercent|credit_usage_percent)"),
    "xai-weekly": re.compile(r"config\.(?:currentPeriod|current_period|monthlyLimit|monthly_limit|creditUsagePercent|credit_usage_percent)"),
}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate quota signal field")
        result[key] = value
    return result


def quota_signal_line(message: str | None) -> str | None:
    if message is None or not message.startswith(MARKER) or "\n" in message or "\r" in message:
        return None
    try:
        event = json.loads(message[len(MARKER):], object_pairs_hook=unique_object)
        if not isinstance(event, dict) or set(event) != {"account_ref", "provider", "probe_ok", "responses", "truncated"}:
            return None
        if not isinstance(event["account_ref"], str) or not ACCOUNT_REF.fullmatch(event["account_ref"]):
            return None
        provider = event["provider"]
        if not isinstance(provider, str) or provider not in PROVIDERS:
            return None
        if type(event["probe_ok"]) is not bool or type(event["truncated"]) is not bool:
            return None
        responses = event["responses"]
        if not isinstance(responses, list) or len(responses) > 8:
            return None
        count = 0
        for response in responses:
            if not isinstance(response, dict) or set(response) != {"source", "valid", "windows"}:
                return None
            source = response["source"]
            allowed = {"xai-monthly", "xai-weekly"} if provider == "xai" else {provider}
            if not isinstance(source, str) or source not in allowed or source not in WINDOW_IDS:
                return None
            if type(response["valid"]) is not bool or not isinstance(response["windows"], list):
                return None
            if not response["valid"] and response["windows"]:
                return None
            for window in response["windows"]:
                count += 1
                if count > 32 or not isinstance(window, dict) or set(window) != {"id", "seconds"}:
                    return None
                if not isinstance(window["id"], str) or not WINDOW_IDS[source].fullmatch(window["id"]):
                    return None
                seconds = window["seconds"]
                if seconds is not None and (type(seconds) is not int or not 0 < seconds <= 315360000):
                    return None
        return MARKER + json.dumps(event, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError, RecursionError):
        return None
