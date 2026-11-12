#!/usr/bin/env bash
# Prints the build number of a clients version, major*10000+minor*100+patch: the Android
# versionCode, the same formula as clients/mobile/version-code.ts. Minor or patch of 100 or more
# would collide with another version, so they're refused.
#   version-code.sh <major.minor.patch>
set -euo pipefail
[[ "${1:-}" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || {
  echo "Clients version '${1:-}' isn't major.minor.patch." >&2
  exit 1
}
major=$((10#${BASH_REMATCH[1]}))
minor=$((10#${BASH_REMATCH[2]}))
patch=$((10#${BASH_REMATCH[3]}))
[ "$minor" -lt 100 ] && [ "$patch" -lt 100 ] || {
  echo "Clients version $1 needs minor and patch below 100." >&2
  exit 1
}
echo $((major * 10000 + minor * 100 + patch))
