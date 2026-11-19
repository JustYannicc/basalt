# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), the commit Ultracite 8.3.0 bundles
- Copied: `skills/install-anti-slop/assets/anti-slop/` at that commit, which is `src/` without its
  `*.test.ts` files, plus the repository `LICENSE`. `vendor/eslint-stylistic/` keeps its own
  `LICENSE` and `UPSTREAM.md`.
- Checked: `diff -r` against that commit's assets finds nothing but this file and `LICENSE`, which
  matches the repository's `LICENSE` byte for byte.
- Entry points: `index.ts` (plugin `anti-slop`) and `effect/index.ts` (plugin `anti-slop-effect`),
  loaded by `../../.oxlintrc.json`. `@oxlint/plugins` is pinned to the owned oxlint version in
  `../../package.json`.
- Deviations: none. Every file here but this one is byte-identical to upstream, recorded with its
  sha256 in `../manifest.json`; the check fails when one differs or is a symbolic link, or when
  `vendor/` holds a file the manifest does not list. Neither oxfmt nor oxlint rewrites the recorded files.
  Configuration choices are recorded in `../../README.md`.

To update, replace this directory's contents with the new upstream commit's assets and
`LICENSE`, keeping this file, and put that commit on the `Commit:` line: the check refuses a
change to the recorded files without a new commit there. Then run
`node scripts/owned-lint/check.ts --write-vendor`, which lists the files added, changed and
removed, and `npm run lint:owned -- --write-baseline`, and review both diffs against upstream.
