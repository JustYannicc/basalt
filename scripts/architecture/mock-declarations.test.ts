import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { mockConformanceErrors } from "./mock-conformance.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const selector = "$(node ../scripts/ci/e2e-pattern.ts mock:rows)";
const title = "Rows retain usable actions on a phone";
const workflow = `jobs:
  account-acquisition:
    needs: select
    if: contains(fromJSON(needs.select.outputs.hosted_jobs), 'account-acquisition')
    steps:
      - working-directory: .upstream
        run: bun run e2e:self-host --test-name "${selector}" --workers 1
  check:
    needs: [select, fast, account-acquisition]
    if: always()
    steps:
      - env:
          CI_NEEDS: \${{ toJSON(needs) }}
          CI_JOBS: \${{ needs.select.outputs.jobs }}
          CI_BOAT_JOBS: \${{ needs.select.outputs.boat_jobs }}
        run: node scripts/ci/gate.ts
`;
const group = { job: "account-acquisition", target: "self-host", mode: "managed" };
const declaration = {
  scenarios: {
    accountRows: {
      title,
      targets: {
        "self-host": { status: "scheduled" },
        local: { status: "not-applicable", reason: "Hosted fixture" },
        cloud: { status: "not-applicable", reason: "Hosted fixture" },
      },
    },
  },
  runs: { accountRows: ["mock:rows"] },
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "basalt-mock-declarations-"));
  roots.push(root);
  const write = (path: string, value: string | object) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value));
  };
  write("e2e/conformance/approved-rows.json", {
    version: 1,
    id: "approved-rows",
    artifact: { name: "approved-rows.html", sha256: "a".repeat(64) },
    requirements: [
      {
        id: "phone-layout",
        text: "Usable rows",
        proofs: [{ scenario: "accountRows", target: "self-host", job: "account-acquisition" }],
      },
    ],
  });
  write(
    ".upstream/e2e/test-plan.ts",
    `export const scenarios = plan({ accountRows: {
    file: "account-rows.spec.ts", title: ${JSON.stringify(title)}, targets: { "self-host": scheduled }
  } });`,
  );
  write(
    ".upstream/e2e/tests/account-rows.spec.ts",
    "it.effect(scenarios.accountRows.title, context => runBrowser(context));",
  );
  write("scripts/ci/inherited-tests.json", { manualTargets: {} });
  write("scripts/ci/e2e-groups.json", { "mock:rows": group });
  write("e2e/plans/account-rows.spec.ts.json", declaration);
  write(".github/workflows/ci.yml", workflow);
  return { write, errors: () => mockConformanceErrors(root, ["account-acquisition"]) };
}

test("the verified declaration CLI retains the named scenario in its required job", () => {
  expect(fixture().errors()).toEqual([]);
  const f = fixture();
  f.write(".upstream/e2e/test-plan.ts", "export const scenarios = plan({});");
  expect(f.errors()).toEqual([]);
});

test("computed selectors cannot change the group, job, target, scenario or failure handling", () => {
  const error =
    "approved-rows/phone-layout/accountRows/self-host: required CI job does not run this scenario";
  for (const broken of [
    workflow.replace("mock:rows", "mock:other"),
    workflow.replace("e2e-pattern.ts", "unverified.ts"),
    workflow.replace("mock:rows", "${GROUP}"),
    workflow.replace("--workers 1", "--workers 1 || true"),
    workflow.replace("e2e:self-host", "e2e:cloud"),
  ]) {
    const f = fixture();
    f.write(".github/workflows/ci.yml", broken);
    expect(f.errors()).toContain(error);
  }
  for (const [broken, expected] of [
    [{ ...group, job: "host-managed-accounts" }, error],
    [{ ...group, target: "cloud" }, "Invalid per-file CI declarations"],
  ]) {
    const f = fixture();
    f.write("scripts/ci/e2e-groups.json", { "mock:rows": broken });
    expect(f.errors()).toContain(expected);
  }
  for (const [broken, expected] of [
    [{ ...declaration, runs: {} }, "Invalid per-file CI declarations"],
    [
      {
        ...declaration,
        scenarios: { unrelated: declaration.scenarios.accountRows },
        runs: { unrelated: ["mock:rows"] },
      },
      error,
    ],
  ]) {
    const f = fixture();
    f.write("e2e/plans/account-rows.spec.ts.json", broken);
    expect(f.errors()).toContain(expected);
  }
});
