# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop (MIT, see `LICENSE`)
- Commit: `13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13), the commit Ultracite 8.3.0 bundles
- Copied: `skills/install-anti-slop/assets/anti-slop/` at that commit, which is `src/` without its
  `*.test.ts` files, plus the repository `LICENSE`. `vendor/eslint-stylistic/` keeps its own
  `LICENSE` and `UPSTREAM.md`.
- Entry points: `index.ts` (plugin `anti-slop`) and `effect/index.ts` (plugin `anti-slop-effect`),
  loaded by `../../.oxlintrc.json`. `@oxlint/plugins` is pinned to the owned oxlint version in
  `../../package.json`.
- Deviations: none. The files are byte-identical to upstream, and neither oxfmt nor oxlint
  rewrites them (`vendored` in `../../check.ts`). Configuration choices are recorded in
  `../../README.md`.

To update, copy the assets of the new upstream commit over this directory, record the commit
here, run `npm run lint:owned -- --write-baseline`, and review the baseline diff.
