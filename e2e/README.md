# Slack account checks

Run this scenario when changing the carried Slack package's health or identity reads. It deploys the actual package to an isolated self-host server and checks the public account-health API against synthetic Slack metadata. Two OAuth accounts connected with an earlier package must remain usable after the update.

Prepare the pinned server once:

```sh
node scripts/prepare-upstream.ts
bun run --cwd .upstream e2e:prepare
```

Use the repository's pinned Bun 1.4.2 for preparation and execution. To verify an upgrade, save the earlier package and pass its path:

```sh
git show <base-commit>:src/catalog/slack.json > .generated/slack-before-health.json
bun e2e/slack-health.mjs .generated/slack-health/run .generated/slack-before-health.json
```

Omitting the earlier package checks redeployment of the current package. The scenario reports a failure when any health classification, identity field or retained account is wrong. `report.json` records the checks and both package hashes. Runtime failures retain partial results and private diagnostics. Session files remain local and must not be uploaded. The fixture supports sign-in and account metadata only.
