#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.upstream"
playwright=./node_modules/.bin/playwright
install_cached_deps() {
  shopt -s nullglob
  debs=("$RUNNER_TEMP/playwright-apt/"*.deb)
  if ((${#debs[@]})); then
    sudo dpkg --install "${debs[@]}"
  fi
  # A partial cache must fail offline rather than silently starting downloads.
  "$playwright" install-deps --dry-run chromium
}
if [[ "${1:-false}" == true ]]; then
  install_cached_deps
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
# Keep Playwright's package selection, but never unpack under the mirror deadline.
download_config="$RUNNER_TEMP/playwright-download-only.conf"
printf '%s\n' 'Binary::apt-get::APT::Get::Download-Only "true";' > "$download_config"
download_deps() {
  sudo timeout --kill-after=5s 60s bash -c \
    'APT_CONFIG="$1" exec "$2" install-deps chromium' -- "$download_config" "$playwright"
}
if ! download_deps; then
  sudo sed -i 's|archive.ubuntu.com|azure.archive.ubuntu.com|g' "${sources[@]}"
  download_deps
fi
install_cached_deps
