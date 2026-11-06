import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { selectPaths } from "./ci/affected.ts";
import { gateErrors, fastJobs, bundleJobs } from "./ci/gate.ts";
import { heavyJobs } from "./ci/areas.ts";
import { patternForGroup, readDeclarations } from "./ci/declarations.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const workflow = parse(
  readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const ids = ["host-managed-accounts", "host-managed-accounts-pool"];
const [accounts, pool] = ids.map((id) => workflow.jobs[id]);

const selectedScenarios = (pattern: string) =>
  Object.values(readDeclarations().files)
    .flatMap((file) => Object.entries(file.scenarios))
    .filter(([, plan]) => {
      const target = plan.targets["self-host"];
      assert.ok(target !== null && typeof target === "object" && "status" in target);
      return target.status === "scheduled" && new RegExp(pattern).test(plan.title);
    })
    .map(([key]) => key)
    .sort();

test("account and pool jobs retain their owned scenarios, commands and execution inputs", () => {
  const expected = [
    {
      job: "host-managed-accounts",
      name: "Verify app query phase diagnostics",
      run: 'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts host-managed-accounts:app-query-phase-diagnostics)" --workers 1',
      env: null,
      cwd: ".upstream",
      minutes: null,
      scenarios: ["appQueryTiming", "appUiPhaseHeaders"],
    },
    {
      job: "host-managed-accounts",
      name: "Verify catalog service identity and import compatibility",
      run: 'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts host-managed-accounts:catalog-service-identity-and-import-compatibility)" --workers 1',
      env: null,
      cwd: ".upstream",
      minutes: null,
      scenarios: ["appPackageMetadata", "mcpAuthDiscovery", "serviceInstallIdentity"],
    },
    {
      job: "host-managed-accounts",
      name: "Verify host-managed visibility and existing account behavior",
      run: 'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts host-managed-accounts:host-managed-visibility-and-existing-account-behavior)" --workers 1',
      env: null,
      cwd: ".upstream",
      minutes: null,
      scenarios: [
        "accountDisplayStatus",
        "accountHealth",
        "accountToolsHealth",
        "catalogOAuthAccounts",
        "catalogOAuthClients",
        "executorAppCardAccount",
        "executorInstallationLoading",
        "executorKeyAccount",
        "executorKeyUnlinkSticks",
        "hostManagedAccounts",
        "hostedScopeRefusal",
        "invitationRolePrivateAccounts",
        "invitationRoles",
        "productBrand",
        "provisionedAccounts",
        "provisionedAgent",
        "provisionedCompactRow",
        "provisionedRadio",
        "storageMigrationDiagnostics",
      ],
    },
    {
      job: "host-managed-accounts-pool",
      name: "Verify retained pool accounts and usage behavior",
      run: 'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts host-managed-accounts-pool:retained-pool-accounts-and-usage-behavior)" --workers 1',
      env: null,
      cwd: ".upstream",
      minutes: null,
      scenarios: [
        "accountObservationInterval",
        "appModelLifecycle",
        "appModelRequests",
        "catalogInstances",
        "catalogOAuthDeferrals",
        "nativePoolAccountMirrors",
        "poolCreation",
        "poolSeedNativeUpgrade",
        "poolSharing",
        "poolSharingUi",
        "poolUsageNavigation",
        "poolUsageUi",
      ],
    },
    {
      job: "host-managed-accounts-pool",
      name: "Keep listed account actions usable during the detail read",
      run: 'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts host-managed-accounts-pool:listed-account-actions)" --workers 1',
      env: null,
      cwd: ".upstream",
      minutes: null,
      scenarios: [
        "listedAccountDelete",
        "listedAccountDeleteMobile",
        "listedAccountDemotion",
        "listedAccountDemotionMobile",
        "listedAccountEdit",
        "listedAccountEditMobile",
        "listedAccountReadonly",
        "listedAccountReadonlyMobile",
        "listedAppAccountEdit",
        "listedAppAccountEditMobile",
        "listedBindingCompactRow",
        "listedBindingRemove",
        "listedBindingRemoveMobile",
        "listedSetupAccount",
        "listedSetupAccountMobile",
      ],
    },
    {
      job: "host-managed-accounts-pool",
      name: "Verify bounded per-account usage through the public host API",
      run: 'bun run e2e:self-host --test-name "$(node ../scripts/ci/e2e-pattern.ts host-managed-accounts-pool:bounded-per-account-usage-through-the-public-host-api)" --workers 1',
      env: null,
      cwd: ".upstream",
      minutes: null,
      scenarios: ["poolUsageSeries"],
    },
  ];
  const commands = [accounts, pool].flatMap((job, index) =>
    job.steps
      .filter((step: { run?: string }) => step.run?.includes("--test-name"))
      .map(
        (step: {
          name: string;
          run: string;
          env?: Record<string, string>;
          "working-directory"?: string;
          "timeout-minutes"?: number;
        }) => ({
          job: ids[index],
          name: step.name,
          run: step.run,
          env: step.env ?? null,
          cwd: step["working-directory"] ?? null,
          minutes: step["timeout-minutes"] ?? null,
        }),
      ),
  );
  assert.deepEqual(
    commands,
    expected.map(({ scenarios: _scenarios, ...command }) => command),
  );
  for (const command of expected) {
    const group = /e2e-pattern\.ts ([a-z0-9:-]+)\)/.exec(command.run);
    assert.ok(group);
    assert.deepEqual(selectedScenarios(patternForGroup(group[1]!)), command.scenarios);
  }
  const behavior = expected
    .filter(
      (command) =>
        command.name === "Verify host-managed visibility and existing account behavior" ||
        command.name === "Verify retained pool accounts and usage behavior",
    )
    .flatMap((command) => command.scenarios);
  assert.equal(new Set(behavior).size, behavior.length);
  assert.equal(
    accounts.steps.filter(
      (step: { run?: string }) =>
        step.run === "node --test scripts/pool-ui-tests/accounts-ready.test.mjs",
    ).length,
    1,
  );
});

test("both halves prepare independently, retain evidence and keep the 20-minute limit", () => {
  assert.deepEqual(accounts.steps.slice(0, 6), pool.steps.slice(0, 6));
  for (const [index, job] of [accounts, pool].entries()) {
    assert.equal(job.needs, "select");
    assert.equal(job["runs-on"], "ubuntu-latest");
    assert.equal(job["timeout-minutes"], 20);
    assert.equal(job.if, `contains(fromJSON(needs.select.outputs.hosted_jobs), '${ids[index]}')`);
    assert.deepEqual(job.steps.at(-2), accounts.steps.at(-2));
    assert.equal(job.steps.at(-2).if, "always()");
    assert.equal(job.steps.at(-1).if, "always()");
    assert.equal(job.steps.at(-1).with.name, `${ids[index]}-self-host-e2e`);
  }
});

test("affected selection and aggregate require both account halves", () => {
  const selected = selectPaths([".upstream/e2e/tests/listed-account-actions.spec.ts"]).jobs;
  for (const id of ids) {
    assert.ok(selected.includes(id));
    assert.ok(workflow.jobs.check.needs.includes(id));
    const needs = Object.fromEntries(
      [...fastJobs, ...heavyJobs, ...bundleJobs].map((job) => [
        job,
        { result: bundleJobs.includes(job) ? "skipped" : "success" },
      ]),
    );
    assert.deepEqual(gateErrors(needs, heavyJobs, [], true), []);
    needs[id] = { result: "skipped" };
    assert.ok(gateErrors(needs, heavyJobs, [], true).some((error) => error.startsWith(id + ":")));
  }
});
