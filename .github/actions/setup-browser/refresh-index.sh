#!/usr/bin/env bash
set -euo pipefail
# A healthy refresh takes seconds. The per-connection timeout misses a download that crawls rather
# than stalls, so each try also gets a hard bound. Two tries and the pause take at most about 105 s,
# and the download's own bound about 130 s, so an unreachable archive fails inside the setup step.
bound="${BROWSER_APT_REFRESH_SECONDS:-45}"
pause="${BROWSER_APT_REFRESH_PAUSE_SECONDS:-5}"
log="$(mktemp)"
refresh() {
  sudo timeout --kill-after=5s "${bound}s" apt-get \
    -o Acquire::http::Timeout=15 -o Acquire::https::Timeout=15 -o Acquire::Retries=0 \
    -o APT::Update::Error-Mode=any update 2>&1 | tee "$log"
}
# Hosted images point -security at one host outside their mirror list, and that host fails on its
# own. The browser packages come from the release and updates pockets, so a -security index that
# can't be fetched keeps the image's copy. Any other failed index, or any other error, still fails.
only_security_failed() {
  local line failed=0
  while IFS= read -r line; do
    if [[ "$line" =~ ^E:\ Failed\ to\ fetch\ [a-z+]+://[^[:space:]]+/dists/[^/[:space:]]+-security/ ]]; then
      failed=1
    elif [[ "$line" != "E: Some index files failed to download. They have been ignored, or old ones used instead." ]]; then
      return 1
    fi
  done < <(grep '^E: ' "$log")
  ((failed))
}
try() {
  local status=0
  refresh || status=$?
  if ((status == 100)) && only_security_failed; then
    echo "::warning::Ubuntu's security index couldn't be fetched, so it keeps the image's copy; the browser packages come from the release and updates pockets."
    status=0
  fi
  return "$status"
}
status=0
try || status=$?
if ((status)); then
  echo "::warning::The apt index refresh failed with status $status (124 is the ${bound}s bound); retrying once after ${pause}s."
  sleep "$pause"
  try
fi
