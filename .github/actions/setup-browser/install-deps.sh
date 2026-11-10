#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.upstream"
playwright=./node_modules/.bin/playwright
if [[ "${1:-false}" == true ]]; then
  shopt -s nullglob
  debs=("$RUNNER_TEMP/playwright-apt/"*.deb)
  if ((${#debs[@]})); then
    sudo timeout --kill-after=5s 60s dpkg --install "${debs[@]}"
  fi
  # A partial cache must fail offline rather than silently starting downloads.
  "$playwright" install-deps --dry-run chromium
  exit
fi
mkdir -p "$RUNNER_TEMP/playwright-apt"
sudo tee /etc/apt/apt.conf.d/99-playwright-ci > /dev/null <<EOF_APT
Dir::Cache::archives "$RUNNER_TEMP/playwright-apt";
APT::Keep-Downloaded-Packages "true";
Binary::apt-get::APT::Keep-Downloaded-Packages "true";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::Retries "0";
EOF_APT
# Hosted runners also select mirrors through a file, outside the sources themselves.
sources=(/etc/apt/sources.list.d/ubuntu.sources)
if [[ -f /etc/apt/sources.list ]]; then sources+=(/etc/apt/sources.list); fi
if [[ -f /etc/apt/apt-mirrors.txt ]]; then sources+=(/etc/apt/apt-mirrors.txt); fi
sudo sed -i 's|azure.archive.ubuntu.com|archive.ubuntu.com|g' "${sources[@]}"
# Apt's per-request inactivity limit does not bound a complete index refresh.
if ! sudo timeout --kill-after=5s 60s "$playwright" install-deps chromium; then
  sudo sed -i 's|archive.ubuntu.com|azure.archive.ubuntu.com|g' "${sources[@]}"
  sudo timeout --kill-after=5s 60s "$playwright" install-deps chromium
fi
