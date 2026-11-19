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
- Deviations: none. The code files are byte-identical to upstream, recorded with their sha256 in
  `../manifest.json`; the check fails when one differs, and lints any other file under `vendor/`
  as Basalt code. Neither oxfmt nor oxlint rewrites the recorded files. Configuration choices are
  recorded in `../../README.md`.

To update, copy the assets of the new upstream commit over this directory, record the commit
here, run `node scripts/owned-lint/check.ts --write-vendor` and
`npm run lint:owned -- --write-baseline`, and review both diffs against upstream.
