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

`bun e2e/catalog-compat.mjs .generated/catalog-compat/run all 8` builds every package the catalog serves, as it serves it, on the framework Basalt ships, deploying and removing each through a real server. A package that fails is also built as its publisher serves it. The run fails when the served framework breaks a package that builds as published, and when a failure is missing from `scripts/catalog-compat/known-failures.json` or a listed package builds again. Pass a positive number in place of `all` to build only that many.

`bun e2e/elevenlabs-discovery.mjs .generated/elevenlabs-discovery/run` installs the ElevenLabs catalog package as the catalog serves it, changing only its origin, against a definition that lacks routes two of its static patches target. It fails unless the account is healthy and every tool loads through the same catalog read agents' discovery uses.

The existing Slack sign-in, approval and native-client proof lives in `e2e/slack/`; `node scripts/check-slack.ts` remains its entry point. Its mock serves an external catalog fixture over HTTP. The proof supplies a synthetic OAuth client through the host fixture setting, rather than importing the catalog Worker or the host client implementation. `node --test e2e/slack/fixture.test.mjs` verifies the fixture's catalog, localized package and account metadata endpoints.
