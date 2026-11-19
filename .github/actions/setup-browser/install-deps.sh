#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../../.upstream"
playwright=./node_modules/.bin/playwright
archives="$RUNNER_TEMP/playwright-apt"
shopt -s nullglob
install_cached_deps() {
  debs=("$archives/"*.deb)
  if ((${#debs[@]})); then
    # A cache restored from an older runner image may hold older debs; never downgrade the image.
    sudo dpkg --refuse-downgrade --install "${debs[@]}"
  fi
  # The dry-run counts only installs, so a package left unpacked but unconfigured would pass it.
  sudo dpkg --configure --pending
  # A partial cache must fail offline rather than silently starting downloads.
  "$playwright" install-deps --dry-run chromium
}
if [[ "${1:-false}" == true ]]; then
  install_cached_deps
  exit
fi
mkdir -p "$archives"
# Debs restored from an older image's cache failed the offline install; download a fresh set.
stale=("$archives/"*.deb)
restored=()
if ((${#stale[@]})); then
  for deb in "${stale[@]}"; do
    base="${deb##*/}"
    restored+=("${base%%_*}")
  done
  rm -f "${stale[@]}"
fi
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
# The download skips packages the failed offline install already applied. Fetch their current debs
# too, or the saved cache lacks them and every later job, on this image and the next, goes back to
# the archive.
missing=()
if ((${#restored[@]})); then
  for name in "${restored[@]}"; do
    fresh=("$archives/${name}_"*.deb)
    if ((${#fresh[@]} == 0)) && apt-cache show --no-all-versions "$name" > /dev/null 2>&1; then
      missing+=("$name")
    fi
  done
fi
if ((${#missing[@]})); then
  if ! (cd "$archives" && timeout --kill-after=5s 30s apt-get download "${missing[@]}"); then
    echo "::warning::Couldn't fetch ${missing[*]} for the deb cache, so this job saves none."
    rm -f "$archives/"*.deb
  fi
fi
