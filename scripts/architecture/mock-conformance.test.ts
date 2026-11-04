import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { heavyJobs } from "../ci/areas.ts";
import { afterEach, expect, test } from "vitest";
import { mockConformanceErrors, parseMockContract } from "./mock-conformance.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const contract = () => ({
  version: 1,
  id: "approved-rows",
  artifact: { name: "approved-rows.html", sha256: "a".repeat(64) },
  requirements: [
    {
      id: "phone-layout",
      text: "Rows remain usable at phone width.",
      proofs: [{ scenario: "accountRows", target: "self-host", job: "account-rows" }],
    },
  ],
});
const plan = `export const scenarios = plan({ accountRows: {
  file: "account-rows.spec.ts", title: "Rows retain usable actions on a phone",
  targets: { "self-host": scheduled, cloud: na("Uses loopback") }
} });`;
const implementation = `it.effect(scenarios.accountRows.title, context => withHostedCase(context, runBrowser));`;
const workflow = `jobs:
  account-rows:
    needs: select
    if: contains(fromJSON(needs.select.outputs.hosted_jobs), 'account-rows')
    steps:
      - working-directory: .upstream
        run: bun run e2e:self-host --test-name '^Rows retain usable actions on a phone$' --workers 1
  check:
    needs: [select, fast, account-rows]
`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "basalt-approved-mocks-"));
  roots.push(root);
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  write("e2e/conformance/approved-rows.json", JSON.stringify(contract()));
  write(".upstream/e2e/test-plan.ts", plan);
  write(".upstream/e2e/tests/account-rows.spec.ts", implementation);
  write(".github/workflows/ci.yml", workflow);
  return { root, write, errors: () => mockConformanceErrors(root, ["account-rows"]) };
}

test("a named public-path scenario stays attached to its required CI selector", () => {
  expect(fixture().errors()).toEqual([]);
});

test("a mock cannot be registered without behavioral obligations and proofs", () => {
  for (const value of [
    {},
    { ...contract(), requirements: [] },
    { ...contract(), artifact: { name: "private/path.html", sha256: "not-a-digest" } },
    { ...contract(), requirements: [{ id: "phone-layout", text: "Phone", proofs: [] }] },
    { ...contract(), requirements: [contract().requirements[0], contract().requirements[0]] },
  ])
    expect(() => parseMockContract(value)).toThrow();
  const f = fixture();
  f.write("e2e/conformance/approved-rows.json", "{}");
  expect(f.errors()).toEqual(["approved-rows.json: invalid approved-mock contract"]);
});

test("removing or unscheduling a declaration fails even when the spec still exists", () => {
  for (const broken of [
    plan.replace("accountRows:", "unrelated:"),
    plan.replace('"self-host": scheduled', '"self-host": na("Deferred")'),
  ]) {
    const f = fixture();
    f.write(".upstream/e2e/test-plan.ts", broken);
    expect(f.errors()).toContain(
      "approved-rows/phone-layout/accountRows/self-host: scenario is missing or not scheduled",
    );
  }
});

test("a declaration or comment cannot stand in for an executable scenario", () => {
  for (const broken of [
    "// it.effect(scenarios.accountRows.title, context => runBrowser(context));",
    implementation.replace("accountRows", "unrelated"),
    implementation.replace("it.effect", "it.skip.effect"),
    "const title = scenarios.accountRows.title;",
  ]) {
    const f = fixture();
    f.write(".upstream/e2e/tests/account-rows.spec.ts", broken);
    expect(f.errors()).toContain(
      "approved-rows/phone-layout/accountRows/self-host: behavioral scenario implementation is missing",
    );
  }
});

test("removing the selector, target, required dependency or selected job fails", () => {
  const mutations = [
    workflow.replace("^Rows retain usable actions on a phone$", "^Unrelated$"),
    workflow.replace("e2e:self-host", "e2e:cloud"),
    workflow.replace("[select, fast, account-rows]", "[select, fast]"),
    workflow.replace("    steps:", "    continue-on-error: true\n    steps:"),
    workflow.replace("      - working-directory", "      - if: false\n        working-directory"),
    workflow.replace(
      "    if: contains(fromJSON(needs.select.outputs.hosted_jobs), 'account-rows')",
      "    if: false",
    ),
    workflow.replace("--workers 1", "--workers 1 || true"),
  ];
  for (const broken of mutations) {
    const f = fixture();
    f.write(".github/workflows/ci.yml", broken);
    expect(f.errors()).toContain(
      "approved-rows/phone-layout/accountRows/self-host: required CI job does not run this scenario",
    );
  }
  expect(mockConformanceErrors(fixture().root, [])).toContain(
    "approved-rows/phone-layout/accountRows/self-host: required CI job does not run this scenario",
  );
});

test("shell interpolation cannot substitute an unverified runtime selector", () => {
  const f = fixture();
  f.write(
    ".github/workflows/ci.yml",
    workflow.replace("^Rows retain usable actions on a phone$", "${SCENARIOS}"),
  );
  expect(f.errors()).toContain(
    "approved-rows/phone-layout/accountRows/self-host: required CI job does not run this scenario",
  );
});

test("invalid workflow syntax and a missing aggregate gate fail closed", () => {
  for (const broken of ["jobs: [", "jobs: {}", workflow + "  check: {}\n"]) {
    const f = fixture();
    f.write(".github/workflows/ci.yml", broken);
    expect(f.errors().length).toBeGreaterThan(0);
  }
});

test("the repository keeps its registered mock scenarios in required CI jobs", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  expect(mockConformanceErrors(root, heavyJobs)).toEqual([]);
});
