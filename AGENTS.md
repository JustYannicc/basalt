# Working on Basalt

Before changing anything, read `upstream.json`, then read that repository's
`AGENTS.md` at the exact pinned commit and follow its relevant guidance. A prepared
upstream checkout must match that pin; current upstream branches are not a substitute.

Before carrying a patch or opening an upstream PR, search the pinned upstream
docs, scripts and fixtures for an existing supported path.

For authenticated testing, use upstream's `apps/hosted/testing/cli.ts` for self-host,
cloud dev and running test stages. `apps/hosted/cloud/scripts/test-accounts.ts` is
the deploy-time fixture for dedicated E2E stages. Basalt previews use the
`0019-preview-auth.patch` password sign-in overlay. Keep generated session files
private.

Each `patches/<stem>.patch` has a same-stem JSON record binding its identity,
filename, exact SHA-256 and retirement mapping. `scripts/releases/patches.json`
is the format-4 header; patch filename sort is the sole application order. Add
only the patch and its record for a new carry. Update that record when its content
or filename changes, preserving unrelated record bytes. Retire a carry only through
its explicit mapping and required proof, deleting both files. A generic upstream
subset cannot retire a whole mixed carry; overlays need a reviewed manual retirement.

Public commits, PRs, issues and comments must exclude preview hosts, private fork
refs, local paths, thread links and personal data.

Put each added or changed carry's durable constraint in `architecture/model/carries/<stem>.c4`, matching its patch and record stem. Update it in the same PR, including record-only changes; rename it with the carry and remove it on retirement. Extend the affected model element as shown in `architecture/model/carries/README.md`. Keep shared area files for module responsibilities and structural relationships. Existing prose can stay until its carry changes; record its updated constraint in the carry file.
