#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.upstream"
mkdir -p "$RUNNER_TEMP/playwright-apt"
sudo tee /etc/apt/apt.conf.d/99-playwright-ci > /dev/null <<EOF_APT
Dir::Cache::archives "$RUNNER_TEMP/playwright-apt";
APT::Keep-Downloaded-Packages "true";
Binary::apt-get::APT::Keep-Downloaded-Packages "true";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
Acquire::Retries "0";
EOF_APT
# The runner's Azure mirror stalls on font packages. Keep a second mirror for outages.
sources=(/etc/apt/sources.list.d/ubuntu.sources)
if [[ -f /etc/apt/sources.list ]]; then sources+=(/etc/apt/sources.list); fi
sudo sed -i 's|azure.archive.ubuntu.com|archive.ubuntu.com|g' "${sources[@]}"
if ! bunx playwright install-deps chromium; then
  sudo sed -i 's|archive.ubuntu.com|azure.archive.ubuntu.com|g' "${sources[@]}"
  bunx playwright install-deps chromium
fi
