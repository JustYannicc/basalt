#!/usr/bin/env bash
# Builds a test run of the clients release as a higher version, so an N+1 update can be walked
# from main. Rewrites the four version fields in the runner's checkout only; the commit is unchanged.
#   test-version.sh <test_version> <update_feed> <owner/repo>
# An empty test_version does nothing. What keeps a test version from shipping: this script refuses
# it unless update_feed names a feed other than the Latest release's, and publish refuses a run
# whose recorded feed isn't the Latest release's or whose version differs from its commit's.
set -euo pipefail
test_version="${1:-}" feed="${2:-}" repository="${3:-}"
fail() {
  echo "::error::$1" >&2
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$1" >> "$GITHUB_STEP_SUMMARY"
  exit 1
}
[ -n "$test_version" ] || exit 0
production="$(bash "$(dirname "$0")/desktop/mac/update-feed.sh" url "$repository")" || exit 1
[ -n "$feed" ] && [ "$feed" != "$production" ] ||
  fail "test_version $test_version needs an update_feed other than the Latest release's feed $production; it got '$feed'. Installs of a test version must never check the real feed."
# GitHub serves the production feed under other spellings too (any owner/repo casing, www.), so a
# test feed must live off GitHub altogether rather than merely differ from the production string.
feed_host="$(printf '%s' "$feed" | sed -E 's|^https://([^/]+).*|\1|' | tr '[:upper:]' '[:lower:]')"
case "$feed_host" in
  github.com | *.github.com | githubusercontent.com | *.githubusercontent.com)
    fail "test_version $test_version needs an update_feed off GitHub; '$feed' is on $feed_host, where it could reach the real feed." ;;
esac
code="$(bash "$(dirname "$0")/version-code.sh" "$test_version" 2>&1)" ||
  fail "test_version '$test_version' has no build number: $code"

# node reads and writes the fields the same way the version job and app.config.ts read them.
result="$(mktemp)"
status=0
node - "$test_version" > "$result" 2>&1 <<'NODE' || status=$?
const fs = require("node:fs");
const [next] = process.argv.slice(2);
const json = ["clients/package.json", "clients/desktop/package.json", "clients/mobile/package.json"];
const config = "clients/mobile/app.config.ts";
const pattern = /\bversion: "([^"]+)"/;
const seen = Object.fromEntries([
  ...json.map((file) => [file, JSON.parse(fs.readFileSync(file, "utf8")).version]),
  [config, pattern.exec(fs.readFileSync(config, "utf8"))?.[1] ?? "missing"],
]);
const values = new Set(Object.values(seen));
const refuse = (message) => {
  console.error(message);
  process.exit(1);
};
if (values.size !== 1)
  refuse(`The checkout has no one clients version to raise: ${Object.entries(seen).map(([file, value]) => `${file} is ${value}`).join(", ")}.`);
const [current] = values;
const parts = (version) => version.split(".").map(Number);
const [a, b] = [parts(next), parts(current)];
const higher = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
if (!/^\d+\.\d+\.\d+$/.test(current) || !higher)
  refuse(`test_version ${next} must be higher than the clients version ${current} on this commit.`);
for (const file of json) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  manifest.version = next;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}
fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(pattern, `version: "${next}"`));
console.log(`Building as test version ${next}; this commit is ${current}.`);
NODE
[ "$status" = 0 ] || fail "$(cat "$result")"
cat "$result"
[ -z "${GITHUB_STEP_SUMMARY:-}" ] ||
  echo "Test build: every client is built as $test_version and checks $feed for updates. This run can't be published." >> "$GITHUB_STEP_SUMMARY"
