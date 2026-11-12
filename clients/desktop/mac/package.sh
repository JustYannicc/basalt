#!/usr/bin/env bash
# Builds Signalbox.app for Apple silicon: the SwiftUI menu-bar shell, its updater, a pinned Node
# runtime and the connection bundle from `bun run --cwd clients/desktop build`.
# Usage: FEED_URL=https://…/appcast.xml package.sh <version>
set -euo pipefail
version="${1:?Use package.sh <version>.}"
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
root="$(cd "$desktop/../.." && pwd)"
out="$desktop/dist-packages"
work="${RUNNER_TEMP:-$(mktemp -d)}/signalbox-mac"
# The step summary shows a refusal without opening the job log; local runs have no summary file.
fail() {
  echo "::error::$1" >&2
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$1" >> "$GITHUB_STEP_SUMMARY"
  exit 1
}
# Installed apps check this feed for updates, so a build without one would never update.
feed="${FEED_URL:-}"
[[ "$feed" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~%/+-]*$ ]] ||
  fail "FEED_URL must be an https URL of letters, digits and ._~%/+-; it is '$feed'."
# The updater installs a feed item only when its integer is higher than the running app's, so one
# version maps to one number, the same formula as Android's versionCode in clients/mobile/app.config.ts.
[[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] ||
  fail "package.sh needs a major.minor.patch version; it got '$version'."
major=$((10#${BASH_REMATCH[1]})) minor=$((10#${BASH_REMATCH[2]})) patch=$((10#${BASH_REMATCH[3]}))
[ "$minor" -lt 100 ] && [ "$patch" -lt 100 ] ||
  fail "Version $version doesn't fit the bundle version major*10000+minor*100+patch: minor and patch must be below 100."
bundle_version=$((major * 10000 + minor * 100 + patch))
for file in host.mjs connection.mjs; do
  [ -f "$desktop/.dist/$file" ] || fail "clients/desktop/.dist/$file is missing. Run bun run --cwd clients/desktop build first."
done
rm -rf "$work"
mkdir -p "$work" "$out"

# The bundled Node is the repository's pinned Node (scripts/ci/node-assets.json). Bumping it
# changes the helper's code identity, so macOS asks once more for Keychain access.
assets="$root/scripts/ci/node-assets.json"
node_version="$(node -p 'require(process.argv[1]).version' "$assets")"
node_file="$(node -p 'require(process.argv[1]).assets["darwin-arm64"].file' "$assets")"
node_sha="$(node -p 'require(process.argv[1]).assets["darwin-arm64"].sha256' "$assets")"
archive="${SIGNALBOX_NODE_CACHE:-$work}/$node_file"
if [ ! -f "$archive" ] || [ "$(shasum -a 256 "$archive" | cut -d' ' -f1)" != "$node_sha" ]; then
  mkdir -p "$(dirname "$archive")"
  curl -fsSL --retry 3 -o "$archive" "https://nodejs.org/dist/v$node_version/$node_file"
fi
seen="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
[ "$seen" = "$node_sha" ] || fail "$node_file has SHA-256 $seen, not the $node_sha pinned in scripts/ci/node-assets.json."
node_dir="${node_file%.tar.gz}"
tar -xzf "$archive" -C "$work" "$node_dir/bin/node"

swift build -c release --arch arm64 --package-path "$here" --product Signalbox
bin="$(swift build -c release --arch arm64 --package-path "$here" --show-bin-path)"

app="$work/Signalbox.app"
contents="$app/Contents"
connection="$contents/Resources/connection"
mkdir -p "$contents/MacOS" "$contents/Helpers" "$contents/Frameworks" "$connection/node_modules/@napi-rs"
cp "$bin/Signalbox" "$contents/MacOS/Signalbox"
otool -l "$contents/MacOS/Signalbox" | grep -q 'path @executable_path/../Frameworks ' ||
  fail "The built Signalbox binary has no @executable_path/../Frameworks rpath, so it can't load Sparkle.framework from the bundle. Check linkerSettings in Package.swift."
[ -d "$bin/Sparkle.framework" ] || fail "swift build put no Sparkle.framework in $bin."
# ditto keeps the framework's version symlinks, which a plain copy would turn into duplicates.
sparkle="$contents/Frameworks/Sparkle.framework"
ditto "$bin/Sparkle.framework" "$sparkle"
# The XPC services are only for sandboxed apps; this app isn't sandboxed.
rm -rf "$sparkle/XPCServices" "$sparkle/Versions/B/XPCServices"
cp "$work/$node_dir/bin/node" "$contents/Helpers/signalbox-node"
sed -e "s/SHORT_VERSION/$version/" -e "s/BUNDLE_VERSION/$bundle_version/" -e "s|FEED_URL|$feed|" \
  "$here/Info.plist" > "$contents/Info.plist"
for key in SUFeedURL SUPublicEDKey CFBundleVersion; do
  plutil -extract "$key" raw "$contents/Info.plist" >/dev/null 2>&1 || fail "The packaged Info.plist has no $key."
done
cp "$desktop/.dist/host.mjs" "$desktop/.dist/connection.mjs" "$connection/"
for module in keyring keyring-darwin-arm64; do
  [ -d "$desktop/node_modules/@napi-rs/$module" ] || fail "clients/desktop/node_modules/@napi-rs/$module is missing. Run bun install --cwd clients/desktop on Apple silicon."
  cp -R "$desktop/node_modules/@napi-rs/$module" "$connection/node_modules/@napi-rs/"
done
cp "$root/LICENSE" "$contents/Resources/LICENSE"

iconset="$work/AppIcon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$root/public/brand/logo.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z "$double" "$double" "$root/public/brand/logo.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$contents/Resources/AppIcon.icns"

# Ad-hoc, inside out. The helper keeps one identity across releases while Node is unchanged, so
# the Keychain's "Always Allow" survives app updates.
codesign --force --sign - --identifier run.signalbox.client.connection "$contents/Helpers/signalbox-node"
find "$connection" -name '*.node' -exec codesign --force --sign - {} +
# Sparkle's own order, without --deep: its installer tool, its updater app, then the framework.
# No hardened runtime: library validation would refuse the ad-hoc signed framework.
codesign --force --sign - "$sparkle/Versions/B/Autoupdate"
codesign --force --sign - "$sparkle/Versions/B/Updater.app"
codesign --force --sign - "$sparkle"
codesign --force --sign - --identifier run.signalbox.client "$app"
codesign --verify --strict --deep "$app" || fail "codesign could not verify Signalbox.app."
for part in "$sparkle/Versions/B/Autoupdate" "$sparkle/Versions/B/Updater.app" "$sparkle"; do
  codesign --verify --strict "$part" || fail "codesign could not verify ${part#"$app/"}."
done
[ ! -e "$sparkle/Versions/B/XPCServices" ] || fail "Sparkle.framework still holds XPCServices."

# The bundled runtime must load the native keyring from the bundle, not from this checkout.
(cd "$work" && "$contents/Helpers/signalbox-node" --input-type=module \
  -e "const m = await import('$connection/node_modules/@napi-rs/keyring/index.js'); if (!m.AsyncEntry) process.exit(1)") ||
  fail "The bundled Node could not load the bundled keyring module."

zip="$out/Signalbox-Client-$version-mac-arm64.zip"
dmg="$out/Signalbox-Client-$version-mac-arm64.dmg"
rm -f "$zip" "$dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"
stage="$work/dmg"
mkdir -p "$stage"
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"
# -srcfolder alone lets hdiutil estimate the image size, and that estimate comes up short for this
# bundle ("No space left on device" on the first attempts). Size it explicitly with headroom, and
# refuse early, naming both numbers, when the volume really is too small.
stage_kb="$(du -sk "$stage" | cut -f1)"
image_kb=$((stage_kb * 5 / 4 + 20480))
free_kb="$(df -Pk "$(dirname "$dmg")" | awk 'NR == 2 {print $4}')"
# UDZO writes an uncompressed image first, then the compressed copy.
[ "$free_kb" -ge $((image_kb * 2)) ] ||
  fail "The disk image needs $((image_kb * 2)) KB free next to $dmg; the volume has $free_kb KB."
# hdiutil sometimes reports a busy resource on a first attempt; retry before failing loudly.
hdiutil_err="$work/hdiutil.err"
for attempt in 1 2 3; do
  hdiutil create -volname Signalbox -srcfolder "$stage" -size "${image_kb}k" -ov -format UDZO "$dmg" >/dev/null 2>"$hdiutil_err" && break
  cat "$hdiutil_err" >&2
  [ "$attempt" = 3 ] && fail "hdiutil could not create a ${image_kb} KB disk image from $stage_kb KB of app after 3 attempts: $(tail -n 1 "$hdiutil_err")"
  sleep 5
done
echo "Signalbox.app $version: $(du -sh "$app" | cut -f1) installed, zip $(du -h "$zip" | cut -f1), dmg $(du -h "$dmg" | cut -f1)"
