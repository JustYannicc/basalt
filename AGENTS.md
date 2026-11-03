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

Put a carry's durable constraint in its affected area file under `architecture/model/`; keep module descriptions about responsibilities, not carry summaries.
