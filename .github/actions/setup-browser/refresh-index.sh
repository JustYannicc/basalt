#!/usr/bin/env bash
set -euo pipefail
# A healthy refresh takes seconds. The per-connection timeout misses a download that crawls rather
# than stalls, so each try also gets a hard bound. Two tries and the pause take at most about 105 s,
# and the download's own bound about 130 s, so an unreachable archive fails inside the setup step.
bound="${BROWSER_APT_REFRESH_SECONDS:-45}"
pause="${BROWSER_APT_REFRESH_PAUSE_SECONDS:-5}"
refresh() {
  sudo timeout --kill-after=5s "${bound}s" apt-get \
    -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o Acquire::Retries=0 \
    -o APT::Update::Error-Mode=any update
}
status=0
refresh || status=$?
if ((status)); then
  echo "::warning::The apt index refresh failed with status $status (124 is the ${bound}s bound); retrying once after ${pause}s."
  sleep "$pause"
  refresh
fi
