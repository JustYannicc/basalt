#!/usr/bin/env python3
"""Docker healthcheck for the authenticated pool readiness endpoint."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request


def main() -> int:
    key = os.environ.get("POOL_MANAGEMENT_KEY", "").strip()
    if not key:
        return 1
    request = urllib.request.Request(
        "http://127.0.0.1:8318/ready",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=3) as response:
            payload = json.loads(response.read())
            return 0 if (
                response.status == 200
                and isinstance(payload.get("boot_id"), str)
                and isinstance(payload.get("started_at"), str)
            ) else 1
    except (OSError, ValueError, urllib.error.URLError):
        return 1


if __name__ == "__main__":
    sys.exit(main())
