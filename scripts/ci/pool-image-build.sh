#!/usr/bin/env bash
# docker build with the pool image's one known transient failure retried: the Go module proxy
# resetting a download stream. Any other failure fails at once. Arguments go to docker build.
set -euo pipefail
for attempt in 1 2 3; do
  log=$(mktemp "${RUNNER_TEMP:-/tmp}/pool-build.XXXXXX")
  if docker build "$@" 2>&1 | tee "$log"; then
    exit 0
  else
    status=$?
  fi
  if ((attempt == 3)) || ! grep -F 'read "https://proxy.golang.org/' "$log" | grep -E '[.]zip": stream error: stream ID [0-9]+; INTERNAL_ERROR; received from peer' > /dev/null; then
    exit "$status"
  fi
  echo "::warning::Go module proxy reset the download stream; retrying pool build after attempt $attempt/3"
  sleep "$((attempt * 5))"
done
