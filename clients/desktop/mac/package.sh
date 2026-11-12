#!/usr/bin/env bash
# Builds Signalbox.app for Apple silicon: the SwiftUI menu-bar shell, a pinned Node runtime and the
# connection bundle from `bun run --cwd clients/desktop build`. Usage: package.sh <version>
set -euo pipefail
version="${1:?Use package.sh <version>.}"
here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
root="$(cd "$desktop/../.." && pwd)"
out="$desktop/dist-packages"
work="${RUNNER_TEMP:-$(mktemp -d)}/signalbox-mac"
fail() { echo "::error::$1" >&2; exit 1; }
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
mkdir -p "$contents/MacOS" "$contents/Helpers" "$connection/node_modules/@napi-rs"
cp "$bin/Signalbox" "$contents/MacOS/Signalbox"
cp "$work/$node_dir/bin/node" "$contents/Helpers/signalbox-node"
# CFBundleVersion only accepts dot-separated numbers, so a prerelease suffix stays in the short version.
sed -e "s/SHORT_VERSION/$version/" -e "s/BUNDLE_VERSION/${version%%-*}/" "$here/Info.plist" > "$contents/Info.plist"
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
codesign --force --sign - --identifier run.signalbox.client "$app"
codesign --verify --strict --deep "$app" || fail "codesign could not verify Signalbox.app."

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
for attempt in 1 2 3; do
  hdiutil create -volname Signalbox -srcfolder "$stage" -size "${image_kb}k" -ov -format UDZO "$dmg" >/dev/null && break
  [ "$attempt" = 3 ] && fail "hdiutil could not create a ${image_kb} KB disk image from $stage_kb KB of app after 3 attempts; its error is above."
  sleep 5
done
echo "Signalbox.app $version: $(du -sh "$app" | cut -f1) installed, zip $(du -h "$zip" | cut -f1), dmg $(du -h "$dmg" | cut -f1)"
