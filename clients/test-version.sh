#!/usr/bin/env bash
# Builds a test run of the clients release as a higher version, so an N+1 update can be walked
# from main. Rewrites the four version fields in the runner's checkout only; the commit is unchanged.
#   test-version.sh <test_version> <update_feed>
# An empty test_version does nothing. A test version can never ship: it needs a test update_feed,
# and the publish job refuses every run built with a feed other than the Latest release's.
set -euo pipefail
test_version="${1:-}" feed="${2:-}"
fail() {
  echo "::error::$1" >&2
  [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "$1" >> "$GITHUB_STEP_SUMMARY"
  exit 1
}
[ -n "$test_version" ] || exit 0
[ -n "$feed" ] ||
  fail "test_version $test_version needs a non-empty update_feed. A run with a test feed can never be published, which is what keeps a test version from shipping."
[[ "$test_version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] ||
  fail "test_version must be major.minor.patch; it is '$test_version'."
[ "$((10#${BASH_REMATCH[2]}))" -lt 100 ] && [ "$((10#${BASH_REMATCH[3]}))" -lt 100 ] ||
  fail "test_version $test_version needs minor and patch below 100, so its build number major*10000+minor*100+patch stays unique."

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
