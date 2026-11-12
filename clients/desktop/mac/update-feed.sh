#!/usr/bin/env bash
# The Mac app's update feed, shared by the release workflow, package.sh and local checks.
#   update-feed.sh url <owner/repo> [update_feed]
#     Prints the feed a build checks: the given test feed, or the Latest release's appcast.xml.
#   update-feed.sh check <feed>
#     Refuses a feed URL that isn't https, doesn't end in /appcast.xml or needs escaping.
#   update-feed.sh appcast <zip> <version> <owner/repo> <feed> <appcast.xml>   (key on stdin)
#     Signs the zip with the EdDSA private key read from stdin, checks the signature against
#     SPARKLE_PUBLIC_ED_KEY and the app inside the zip, then writes a one-item appcast.
#     SPARKLE_BIN names the folder holding Sparkle's sign_update. macOS only.
# url and check run anywhere bash does.
set -euo pipefail
zip_name=Signalbox-mac-arm64.zip
fail() {
  echo "::error::$1" >&2
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$1" >> "$GITHUB_STEP_SUMMARY"
  exit 1
}
production_feed() { printf 'https://github.com/%s/releases/latest/download/appcast.xml' "$1"; }
check_repository() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail "'$1' isn't an owner/repository name."
}
# Only characters that need no escaping in package.sh's sed, the plist or the XML.
check_feed() {
  [[ "$1" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~%/+-]*/appcast\.xml$ ]] ||
    fail "The update feed must be an https URL ending in /appcast.xml, of letters, digits and ._~%/+-; it is '$1'."
}

# Exits 0 only when the base64 signature verifies against the base64 public key.
verify() {
  local zip="$1" signature="$2" key="$3" source="$work/verify.swift"
  # CryptoKit's Ed25519 is the check the updater makes against the key in the installed app.
  cat > "$source" <<'SWIFT'
import CryptoKit
import Foundation
let arguments = CommandLine.arguments
guard arguments.count == 4, let key = Data(base64Encoded: arguments[1]),
  let signature = Data(base64Encoded: arguments[2]),
  let data = FileManager.default.contents(atPath: arguments[3]),
  let publicKey = try? Curve25519.Signing.PublicKey(rawRepresentation: key)
else { exit(2) }
exit(publicKey.isValidSignature(signature, for: data) ? 0 : 1)
SWIFT
  xcrun swift "$source" "$key" "$signature" "$zip"
}

case "${1:-}" in
url)
  repository="${2:-}"
  check_repository "$repository"
  feed="${3:-}"
  if [ -z "$feed" ]; then feed="$(production_feed "$repository")"; fi
  check_feed "$feed"
  printf '%s\n' "$feed"
  ;;
check)
  [ "$#" = 2 ] || fail "Use update-feed.sh check <feed>."
  check_feed "$2"
  ;;
appcast)
  [ "$#" = 6 ] || fail "Use update-feed.sh appcast <zip> <version> <owner/repo> <feed> <appcast.xml>, with the key on stdin."
  zip="$2" version="$3" repository="$4" feed="$5" out="$6"
  check_repository "$repository"
  check_feed "$feed"
  [ -f "$zip" ] || fail "There is no Mac zip at $zip."
  [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || fail "The appcast needs a major.minor.patch version; it got '$version'."
  build=$((10#${BASH_REMATCH[1]} * 10000 + 10#${BASH_REMATCH[2]} * 100 + 10#${BASH_REMATCH[3]}))
  [ -n "${SPARKLE_PUBLIC_ED_KEY:-}" ] || fail "SPARKLE_PUBLIC_ED_KEY isn't set; it's the public key installed apps verify updates with."
  sign_update="${SPARKLE_BIN:-}/sign_update"
  [ -x "$sign_update" ] || fail "SPARKLE_BIN has no executable sign_update (looked at '$sign_update')."
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  # The app inside the zip must name this feed and key, or installs of it would check elsewhere
  # or refuse the next update.
  plist="$work/Info.plist"
  unzip -p "$zip" Signalbox.app/Contents/Info.plist > "$plist" 2>/dev/null && [ -s "$plist" ] ||
    fail "$zip holds no Signalbox.app/Contents/Info.plist."
  for pair in "SUFeedURL=$feed" "SUPublicEDKey=$SPARKLE_PUBLIC_ED_KEY" "CFBundleVersion=$build" "CFBundleShortVersionString=$version"; do
    name="${pair%%=*}" want="${pair#*=}"
    seen="$(plutil -extract "$name" raw "$plist" 2>/dev/null || echo missing)"
    [ "$seen" = "$want" ] || fail "The app in $zip has $name '$seen', not '$want'."
  done

  signature="$("$sign_update" --ed-key-file - -p "$zip")" ||
    fail "sign_update couldn't sign $zip with the key on stdin; its error is above."
  [[ "$signature" =~ ^[A-Za-z0-9+/]{86}==$ ]] || fail "sign_update printed '$signature', not a 64-byte base64 signature."
  status=0
  verify "$zip" "$signature" "$SPARKLE_PUBLIC_ED_KEY" || status=$?
  [ "$status" = 0 ] ||
    fail "The signature for $zip doesn't verify against SPARKLE_PUBLIC_ED_KEY $SPARKLE_PUBLIC_ED_KEY (verifier exit $status). The private key on stdin belongs to a different public key."

  # Release builds pin the zip to its tag, so a later release never changes what this item
  # installs; a test feed serves its zip from the same folder.
  if [ "$feed" = "$(production_feed "$repository")" ]; then
    url="https://github.com/$repository/releases/download/signalbox-clients-$version/$zip_name"
  else
    url="${feed%/appcast.xml}/$zip_name"
  fi
  length="$(stat -f %z "$zip")"
  published="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"
  cat > "$out" <<XML
<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Signalbox</title>
    <item>
      <title>Signalbox $version</title>
      <link>https://github.com/$repository/releases/tag/signalbox-clients-$version</link>
      <pubDate>$published</pubDate>
      <sparkle:version>$build</sparkle:version>
      <sparkle:shortVersionString>$version</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <enclosure url="$url" length="$length" type="application/octet-stream" sparkle:edSignature="$signature"/>
    </item>
  </channel>
</rss>
XML
  xmllint --noout "$out" || fail "The written appcast at $out isn't well-formed XML."
  echo "Signed $zip ($length bytes) for $version, build $build; the appcast installs it from $url."
  ;;
*)
  fail "Use update-feed.sh url|check|appcast; see the comment at the top of the script."
  ;;
esac
