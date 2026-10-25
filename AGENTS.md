# Working on Basalt

Before changing anything, read `upstream.json`, then read that repository's
`AGENTS.md` at the exact pinned commit and follow its relevant guidance. A prepared
upstream checkout must match that pin; current upstream branches are not a substitute.

Before carrying a patch or opening an upstream PR, search the pinned upstream
docs, scripts and fixtures for an existing supported path.

For authenticated testing, upstream's fixture at
`apps/hosted/cloud/scripts/test-accounts.ts` covers self-host, cloud dev and test
stages. Basalt previews use the `0019-preview-auth.patch` password sign-in overlay.
Keep generated session files private.

`scripts/releases/patches.json` binds each carry's identity, filename and exact
SHA-256 to its retirement mapping. Update the registry when patch content or its
filename changes. Retire a carry only through its explicit mapping and required
proof. A generic upstream subset cannot retire a whole mixed carry; overlays need
a reviewed manual retirement.

Public commits, PRs, issues and comments must exclude preview hosts, private fork
refs, local paths, thread links and personal data.
