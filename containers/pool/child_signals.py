"""Closed, counts-only projection of child process output."""

from __future__ import annotations

import json
import re
from typing import Any

MAX_HOME_SIGNAL_INTEGER = (1 << 63) - 1

PRIVACY_AUDIT_MARKER = "POOL_PRIVACY_AUDIT "
PRIVACY_PROGRESS_MARKER = "POOL_PRIVACY_PROGRESS "
PRIVACY_RETRY_MARKER = "POOL_PRIVACY_RETRY "
HOME_INIT_FAILURE_MARKER = "POOL_HOME_INIT_FAILURE "
HOME_MAINTENANCE_FAILURE_MARKER = "POOL_HOME_MAINTENANCE_FAILURE "
APP_LOG_PRIVACY_AUDIT_MARKER = "POOL_APP_LOG_PRIVACY_AUDIT "
APP_LOG_WRITE_FAILURE_MARKER = "POOL_APP_LOG_WRITE_FAILURE "
NATIVE_POLICY_FUSED_MARKER = "POOL_NATIVE_POLICY_FUSED "
NATIVE_POLICY_PLUGIN_ID = "basalt-native-policy"
NATIVE_POLICY_PROBE_LOG_PREFIX = "pool-native-policy-probe:"

# Home's pinned LogFormatter adds these columns before the message. Strip only
# that format, then apply the same closed projection used for raw messages.
HOME_LOG_LINE = re.compile(
    r"\[CLIProxyAPIHome\] "
    r"\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] "
    r"\[[^\]\r\n]+\] "
    r"\[(?P<level>panic|fatal|error|warn |info |debug|trace)\] "
    r"(?:\[[^\]\r\n]+:\d+\] )?"
    r"(?P<message>[^\r\n]*)"
)

PRIVACY_AUDIT_FIELDS = frozenset(
    {
        "usage_rows",
        "purged_rows",
        "active_key_count",
        "matched_active_key_copies",
        "deleted_key_count",
        "unknown_key_count",
    }
)
PRIVACY_PROGRESS_FIELDS = frozenset({"batches", "rows_updated"})
PRIVACY_RETRY_FIELDS = frozenset({"attempt", "retry_after_seconds"})
APP_LOG_PRIVACY_AUDIT_FIELDS = frozenset({"log_rows"})
APP_LOG_WRITE_FAILURE_FIELDS = frozenset({"count"})
HOME_INIT_FAILURE_CATEGORIES = ("database", "runtime", "listener", "cluster")
HOME_MAINTENANCE_FAILURE_MESSAGES = {
    "derived_columns": "usage derived-column backfill batch failed",
    "cache_read": "usage cache-read backfill batch failed",
    "token_accounting": "usage token accounting backfill batch failed",
}

# These prefixes come from Home's fixed startup error messages. Their suffixes
# include errors and, in a few cases, dynamic addresses, so none are forwarded.
HOME_INIT_FAILURE_PREFIXES = {
    "database": (
        "failed to validate database snapshot:",
        "failed to validate database snapshot for target backend:",
        "failed to open database:",
        "failed to get sql db:",
        "failed to import database snapshot:",
        "failed to migrate database:",
        "failed to initialize lifecycle configuration:",
        "failed to load database config snapshot:",
        "failed to load database runtime config:",
    ),
    "runtime": (
        "failed to init runtime:",
        "failed to init runtime",
        "failed to start runtime:",
        "failed to apply in-flight observation config:",
        "failed to init management http:",
    ),
    "listener": (
        "failed to resolve listen address:",
        "failed to listen on ",
        "failed to start HTTPS server:",
    ),
    "cluster": (
        "failed to load cluster config:",
        "failed to resolve database node ip:",
        "failed to init runtime certificates:",
        "failed to resolve cluster advertised port:",
        "failed to resolve database node port: listen port must be greater than 0",
        "failed to init cluster runtime adapter",
        "failed to initialize cluster coordinator:",
    ),
}


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate JSON field")
        value[key] = item
    return value


def _extract_home_message(name: str, line: str) -> str | None:
    if name != "home":
        return None

    candidate = line.strip()
    home_log = HOME_LOG_LINE.fullmatch(candidate)
    if home_log is not None:
        return home_log.group("message")
    if candidate.startswith("{"):
        try:
            record = json.loads(candidate, object_pairs_hook=_unique_json_object)
        except (ValueError, TypeError):
            return None
        if not isinstance(record, dict):
            return None
        message = record.get("msg")
        return message if isinstance(message, str) else None

    match = re.search(r"(?:^|\s)msg=", candidate)
    if match is None:
        return candidate
    if " level=" not in candidate[: match.start()]:
        return None
    try:
        message, _ = json.JSONDecoder().raw_decode(candidate[match.end() :])
    except (ValueError, TypeError):
        return None
    return message if isinstance(message, str) else None


def _privacy_signal_line(
    message: str | None,
    marker: str,
    fields: frozenset[str],
) -> str | None:
    if message is None or not message.startswith(marker):
        return None
    try:
        value = json.loads(
            message[len(marker) :], object_pairs_hook=_unique_json_object
        )
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or set(value) != fields:
        return None
    if any(
        type(value[key]) is not int
        or value[key] < 0
        or value[key] > MAX_HOME_SIGNAL_INTEGER
        for key in fields
    ):
        return None
    return marker + json.dumps(value, sort_keys=True, separators=(",", ":"))


def _home_init_failure_category(message: str | None) -> str | None:
    if message is None:
        return None
    for category, prefixes in HOME_INIT_FAILURE_PREFIXES.items():
        for prefix in prefixes:
            if prefix.endswith((":", " ")):
                if message.startswith(prefix):
                    return category
            elif message == prefix:
                return category
    return None


class NativePolicyFuseParser:
    """Project Home's multiline plugin-fuse log to one closed signal."""

    def __init__(self) -> None:
        self._awaiting_plugin_field = False

    def feed(self, name: str, line: str) -> str | None:
        if name != "home":
            self._awaiting_plugin_field = False
            return None

        candidate = line.strip()
        home_log = HOME_LOG_LINE.fullmatch(candidate)
        if home_log is not None:
            self._awaiting_plugin_field = False
            if (
                home_log.group("level") == "error"
                and home_log.group("message").startswith(
                    "pluginhost: plugin panic recovered:"
                )
            ):
                self._awaiting_plugin_field = True
                if _has_native_policy_plugin_id(home_log.group("message")):
                    self._awaiting_plugin_field = False
                    return _native_policy_fused_signal()
            return None

        if candidate.startswith("{"):
            self._awaiting_plugin_field = False
            try:
                record = json.loads(candidate, object_pairs_hook=_unique_json_object)
            except (ValueError, TypeError):
                return None
            if (
                isinstance(record, dict)
                and record.get("level") == "error"
                and isinstance(record.get("msg"), str)
                and record["msg"].startswith("pluginhost: plugin panic recovered:")
                and record.get("plugin_id") == NATIVE_POLICY_PLUGIN_ID
            ):
                return _native_policy_fused_signal()
            return None

        if self._awaiting_plugin_field and _has_native_policy_plugin_id(candidate):
            self._awaiting_plugin_field = False
            return _native_policy_fused_signal()
        return None


def _has_native_policy_plugin_id(value: str) -> bool:
    return re.search(
        rf"(?:^|\s)plugin_id={re.escape(NATIVE_POLICY_PLUGIN_ID)}(?:\s|$)", value
    ) is not None


def _native_policy_fused_signal() -> str:
    return NATIVE_POLICY_FUSED_MARKER + '{"count":1}'


class NativePolicyProbeParser:
    """Recognize only the native plugin's no-account health heartbeat."""

    def feed(self, name: str, line: str) -> str | None:
        if name != "home":
            return None

        candidate = line.strip()
        plugin_id = None
        message: str | None = None
        home_log = HOME_LOG_LINE.fullmatch(candidate)
        if home_log is not None:
            if home_log.group("level").strip() != "info":
                return None
            home_message = home_log.group("message")
            message = home_message
            plugin_id = NATIVE_POLICY_PLUGIN_ID if _has_native_policy_plugin_id(home_message) else None
        elif candidate.startswith("{"):
            try:
                record = json.loads(candidate, object_pairs_hook=_unique_json_object)
            except (ValueError, TypeError):
                return None
            if isinstance(record, dict) and record.get("level") == "info":
                message = record.get("msg") if isinstance(record.get("msg"), str) else None
                plugin_id = record.get("plugin_id")
        else:
            level = re.search(r"(?:^|\s)level=(?:\"?)(info)(?:\"?)(?:\s|$)", candidate)
            msg = re.search(r"(?:^|\s)msg=", candidate)
            if level is None or msg is None:
                return None
            try:
                decoded, _ = json.JSONDecoder().raw_decode(candidate[msg.end() :])
            except (ValueError, TypeError):
                return None
            message = decoded if isinstance(decoded, str) else None
            plugin_id = NATIVE_POLICY_PLUGIN_ID if _has_native_policy_plugin_id(candidate) else None

        if plugin_id != NATIVE_POLICY_PLUGIN_ID or message is None:
            return None
        match = re.search(
            rf"(?:^|\s){re.escape(NATIVE_POLICY_PROBE_LOG_PREFIX)}([A-Za-z0-9_-]{{16,96}})(?:\s|$)",
            message,
        )
        return match.group(1) if match is not None else None


def safe_child_output_line(name: str, line: str) -> str | None:
    """Return closed Home worker signals and fixed failure counts."""
    message = _extract_home_message(name, line)
    for marker, fields in (
        (PRIVACY_AUDIT_MARKER, PRIVACY_AUDIT_FIELDS),
        (PRIVACY_PROGRESS_MARKER, PRIVACY_PROGRESS_FIELDS),
        (PRIVACY_RETRY_MARKER, PRIVACY_RETRY_FIELDS),
        (APP_LOG_PRIVACY_AUDIT_MARKER, APP_LOG_PRIVACY_AUDIT_FIELDS),
        (APP_LOG_WRITE_FAILURE_MARKER, APP_LOG_WRITE_FAILURE_FIELDS),
    ):
        safe = _privacy_signal_line(message, marker, fields)
        if safe is not None:
            return safe

    for category, fixed_message in HOME_MAINTENANCE_FAILURE_MESSAGES.items():
        if message == fixed_message or (
            message is not None and message.startswith(fixed_message + " error=")
        ):
            counts = {
                field: int(field == category)
                for field in HOME_MAINTENANCE_FAILURE_MESSAGES
            }
            return HOME_MAINTENANCE_FAILURE_MARKER + json.dumps(
                counts, sort_keys=True, separators=(",", ":")
            )

    category = _home_init_failure_category(message)
    if category is None:
        return None
    counts = {field: int(field == category) for field in HOME_INIT_FAILURE_CATEGORIES}
    return HOME_INIT_FAILURE_MARKER + json.dumps(
        counts, sort_keys=True, separators=(",", ":")
    )


def privacy_audit_line(name: str, line: str) -> str | None:
    """Keep the existing audit-only helper available to callers and tests."""
    return _privacy_signal_line(
        _extract_home_message(name, line),
        PRIVACY_AUDIT_MARKER,
        PRIVACY_AUDIT_FIELDS,
    )

