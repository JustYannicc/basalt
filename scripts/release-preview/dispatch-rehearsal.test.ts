import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { missingInputs, rehearsalInputs } from "./dispatch-rehearsal.ts";
import { subscriptionSmokeInputs } from "./credentials.ts";

const workflow = readFileSync(
  new URL("../../.github/workflows/release-rehearsal.yml", import.meta.url),
  "utf8",
);

test("a dispatch requires every input the rehearsal workflow reads, less subscriptions when infra-only", () => {
  const full = rehearsalInputs(workflow, false);
  const infra = rehearsalInputs(workflow, true);
  for (const name of [
    "CLOUDFLARE_API_TOKEN",
    "PREVIEW_STATE_KEY",
    "PREVIEW_SMOKE_EMAIL",
    "RELEASE_REHEARSAL_SENTRY_DSN",
  ])
    assert.ok(full.secrets.includes(name) && infra.secrets.includes(name), name);
  assert.ok(full.vars.includes("TEST_STAGE_DOMAIN") && infra.vars.includes("TEST_STAGE_DOMAIN"));
  for (const name of subscriptionSmokeInputs) {
    assert.ok([...full.secrets, ...full.vars].includes(name), name);
    assert.ok(![...infra.secrets, ...infra.vars].includes(name), name);
  }
  const present = { secrets: infra.secrets, vars: infra.vars };
  assert.deepEqual(missingInputs(infra, present), []);
  assert.deepEqual(missingInputs(full, present).sort(), [
    "secret PREVIEW_CLAUDE_AUTH_JSON",
    "secret PREVIEW_CODEX_CLI_AUTH_JSON",
    "secret PREVIEW_CODEX_SUBSCRIPTION_AUTH_JSON",
    "variable PREVIEW_CLAUDE_MODEL",
    "variable PREVIEW_CODEX_MODEL",
  ]);
});
