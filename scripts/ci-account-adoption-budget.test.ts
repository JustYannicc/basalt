import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readDeclarations, patternForGroup } from "./ci/declarations.ts";
import { selectPaths } from "./ci/affected.ts";
import { heavyJobs } from "./ci/areas.ts";
import { bundleJobs, conditionalJobs, fastJobs, gateErrors } from "./ci/gate.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const job = "host-managed-accounts-adopted";
const group = job + ":audited-account-compatibility";
const previous = "host-managed-accounts:host-managed-visibility-and-existing-account-behavior";
const expected = [
  "accountAppTabs",
  "accountCacheScope",
  "accountCheckFailureDetail",
  "accountChoice",
  "accountLinking",
  "accountSetDeclarations",
  "accountVersion",
  "appAccountOAuth",
  "appAccountPicker",
  "appWorkerCredentialRotation",
  "connectedAgents",
  "credentialManagedPlaced",
  "credentialManagedScopes",
  "hostedAppAccountReconnectBrowser",
  "hostedAppAccountWebhookRemoval",
  "hostedAppAccountsManagerBrowser",
  "hostedAppAccountsMemberBrowser",
  "hostedAppLinkHeldAccess",
  "hostedAppSchedulesBrowser",
  "mcpAccountChoice",
  "mcpLateRefreshReuse",
  "mcpProtocol",
  "mcpStaleRefresh",
  "oauthCacheScope",
  "oauthClientCredentials",
  "oauthClientCredentialsRequestOptions",
  "oauthClientIssuerMigration",
  "resourceSharing",
];

test("all 28 audited self-host scenarios move once without changing their other targets", () => {
  const declarations = readDeclarations();
  const selected = Object.values(declarations.files)
    .flatMap((file) =>
      Object.entries(file.runs)
        .filter(([, runs]) => runs.includes(group))
        .map(([key]) => key),
    )
    .sort();
  assert.deepEqual(selected, expected);
  assert.equal(declarations.groups[group]!.job, job);
  assert.equal(declarations.groups[group]!.target, "self-host");
  assert.equal(declarations.groups[group]!.mode, "managed");
  for (const file of Object.values(declarations.files)) {
    for (const key of expected.filter((key) => file.scenarios[key])) {
      const runs = file.runs[key]!;
      assert.deepEqual(
        runs.filter((id) => declarations.groups[id]!.target === "self-host"),
        [group],
      );
      assert.ok(!runs.includes(previous));
      assert.ok(new RegExp(patternForGroup(group)).test(file.scenarios[key]!.title));
      assert.ok(!new RegExp(patternForGroup(previous)).test(file.scenarios[key]!.title));
    }
  }
});

test("the audited partition keeps preparation, evidence and the unchanged 20-minute limit", () => {
  const original = workflow.jobs["host-managed-accounts"];
  const audited = workflow.jobs[job];
  assert.equal(original["timeout-minutes"], 20);
  assert.equal(audited["timeout-minutes"], original["timeout-minutes"]);
  assert.equal(audited.needs, "select");
  assert.equal(audited.if, `contains(fromJSON(needs.select.outputs.hosted_jobs), '${job}')`);
  assert.deepEqual(audited.steps.slice(0, 6), original.steps.slice(0, 6));
  const runs = audited.steps.filter((step: { run?: string }) =>
    step.run?.includes("e2e:self-host"),
  );
  assert.equal(runs.length, 1);
  assert.equal(
    runs[0].run,
    `bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts ${group})" --workers 1`,
  );
  assert.equal(runs[0]["working-directory"], ".upstream");
  assert.equal(runs[0]["timeout-minutes"], undefined);
  assert.deepEqual(audited.steps.at(-2), original.steps.at(-2));
  assert.equal(audited.steps.at(-2).if, "always()");
  assert.equal(audited.steps.at(-1).if, "always()");
  assert.equal(audited.steps.at(-1).with.name, job + "-self-host-e2e");
});

test("affected selection and the full aggregate cannot skip the audited partition", () => {
  assert.ok(heavyJobs.includes(job));
  assert.ok(selectPaths([".upstream/e2e/tests/account-cache-scope.spec.ts"]).jobs.includes(job));
  assert.ok(workflow.jobs.check.needs.includes(job));
  const needs = Object.fromEntries(
    [...fastJobs, ...heavyJobs, ...bundleJobs, ...conditionalJobs].map((id) => [
      id,
      {
        result:
          bundleJobs.includes(id) || (conditionalJobs.includes(id) && id !== "workerd-assets")
            ? "skipped"
            : "success",
      },
    ]),
  );
  assert.deepEqual(gateErrors(needs, heavyJobs, [], true), []);
  needs[job] = { result: "skipped" };
  assert.ok(gateErrors(needs, heavyJobs, [], true).some((error) => error.startsWith(job + ":")));
});
