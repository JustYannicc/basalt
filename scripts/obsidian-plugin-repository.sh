#!/usr/bin/env bash
# Pushes one Signalbox Sync build to the plugin's own repository as a commit and a bare version tag,
# in Obsidian's layout: manifest.json and versions.json at the root, the build under dist/.
# Usage: obsidian-plugin-repository.sh <remote> <build dir> <versions.json> <work dir>
# Prints "pushed" or "existing". A version already there with other bytes is refused: published
# versions never change.
set -euo pipefail

remote="$1" dist="$2" versions="$3" work="$4"
version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$dist/manifest.json")"
git clone --quiet "$remote" "$work"

if git -C "$work" rev-parse --quiet --verify "refs/tags/$version" > /dev/null; then
  for file in dist/main.js manifest.json dist/styles.css; do
    if ! git -C "$work" show "$version:$file" | cmp -s - "$dist/$(basename "$file")"; then
      echo "The plugin repository already has $version and its $file differs from this build. Published versions never change: raise version in clients/obsidian/manifest.json and versions.json." >&2
      exit 1
    fi
  done
  echo existing
  exit 0
fi

mkdir -p "$work/dist"
cp "$dist/main.js" "$dist/styles.css" "$work/dist/"
cp "$dist/manifest.json" "$work/manifest.json"
cp "$versions" "$work/versions.json"
git -C "$work" add dist manifest.json versions.json
git -C "$work" -c user.name="github-actions[bot]" \
  -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
  commit --quiet -m "Signalbox Sync $version" -m "Built from JustYannicc/basalt@${GITHUB_SHA:-local}."
git -C "$work" tag "$version"
git -C "$work" push --quiet --atomic origin HEAD:refs/heads/main "refs/tags/$version"
echo pushed
