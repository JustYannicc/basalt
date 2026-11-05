import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  symlinkSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { finalizeE2e } from "./e2e-finalize.ts";

function fixture(t: { after: (use: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "basalt-e2e-retention-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = join(root, ".upstream/.local/e2e/run-one");
  mkdirSync(join(run, "cloud/report/diagnostics"), { recursive: true });
  writeFileSync(join(run, ".basalt-run-owner.json"), JSON.stringify({ pid: process.pid }));
  writeFileSync(join(run, "evidence.json"), "{}");
  for (const file of [
    "compiler-cache-host.log",
    "compiler-cache-production.json",
    "physical-state-digests.ndjson",
    "physical-provisioning-completed.json",
    "sso-idp.log",
  ])
    writeFileSync(join(run, "cloud", file), "selected-diagnostic");
  writeFileSync(join(run, "cloud/report/diagnostics/result.json"), "synthetic-evidence");
  mkdirSync(join(run, "cloud/database"));
  writeFileSync(join(run, "cloud/database/private.json"), "private-runtime-data");
  const active = join(root, ".upstream/.local/e2e/run-active");
  mkdirSync(active);
  writeFileSync(join(active, "active"), "preserve");
  return { root, run, active, artifacts: join(root, "artifacts") };
}

test("local completion records a bounded verdict and removes only the completed run", (t) => {
  const { root, run, active, artifacts } = fixture(t);
  finalizeE2e(root, run, "passed", { ci: false, retain: undefined, artifacts });
  assert.equal(existsSync(run), false);
  assert.equal(existsSync(active), true);
  const result = readFileSync(join(root, ".generated/e2e-records/run-one.json"), "utf8");
  assert.equal(JSON.parse(result).outcome, "passed");
  assert.ok(result.length < 1024);
});

test("failed runs export selected CI evidence before pruning and never follow runtime links", (t) => {
  const { root, run, artifacts } = fixture(t);
  symlinkSync(join(run, "cloud/database"), join(run, "cloud/report/runtime-link"));
  mkdirSync(join(run, "self-host/scenarios/failed/database"), { recursive: true });
  writeFileSync(join(run, "self-host/scenarios/failed/server.log"), "scenario-server-log");
  writeFileSync(join(run, "self-host/scenarios/failed/database/private.json"), "private");
  finalizeE2e(root, run, "failed", { ci: true, retain: undefined, artifacts });
  const retained = join(root, ".generated/e2e-evidence/run-one");
  assert.equal(existsSync(join(retained, "cloud/report/diagnostics/result.json")), true);
  assert.equal(existsSync(join(retained, "cloud/database")), false);
  for (const file of [
    "compiler-cache-host.log",
    "compiler-cache-production.json",
    "physical-state-digests.ndjson",
    "physical-provisioning-completed.json",
    "sso-idp.log",
  ])
    assert.equal(readFileSync(join(retained, "cloud", file), "utf8"), "selected-diagnostic");
  assert.equal(existsSync(join(retained, "cloud/report/runtime-link")), false);
  assert.equal(
    readFileSync(join(retained, "self-host/scenarios/failed/server.log"), "utf8"),
    "scenario-server-log",
  );
  assert.equal(existsSync(join(retained, "self-host/scenarios/failed/database")), false);
  assert.equal(existsSync(run), false);
});

test("successful CI export preserves scope-proof metadata before pruning the original run", (t) => {
  const { root, run, artifacts } = fixture(t);
  const receipts = {
    "environment.json": JSON.stringify({ prebuiltFramework: true }),
    "runtime-preboot.json": JSON.stringify({ binding: "host", launches: 2 }),
    "runtime-launches.ndjson": '{"launch":1}\n{"launch":2}\n',
    "runtime-switches.ndjson": '{"binding":"host","launches":2}\n',
  };
  for (const [name, contents] of Object.entries(receipts))
    writeFileSync(join(run, "cloud", name), contents);
  finalizeE2e(root, run, "passed", { ci: true, retain: undefined, artifacts });
  const retained = join(root, ".generated/e2e-evidence/run-one/cloud");
  assert.equal(existsSync(run), false);
  for (const [name, contents] of Object.entries(receipts))
    assert.equal(readFileSync(join(retained, name), "utf8"), contents);
  assert.equal(
    JSON.parse(readFileSync(join(retained, "environment.json"), "utf8")).prebuiltFramework,
    true,
  );
  assert.equal(existsSync(join(retained, "database")), false);
});

test("explicit owner retention survives pruning and an export failure leaves the run intact", (t) => {
  const { root, run, artifacts } = fixture(t);
  const retain = join(artifacts, "owner-proof");
  finalizeE2e(root, run, "failed", { ci: false, retain, artifacts });
  assert.equal(existsSync(join(retain, "run-one/cloud/report/diagnostics/result.json")), true);
});

test("invalid retention or another owner's run is refused without deleting evidence", (t) => {
  const { root, run, artifacts } = fixture(t);
  assert.throws(() =>
    finalizeE2e(root, run, "failed", { ci: false, retain: join(root, "outside"), artifacts }),
  );
  assert.equal(existsSync(run), true);
  writeFileSync(join(run, ".basalt-run-owner.json"), JSON.stringify({ pid: 1 }));
  assert.throws(() => finalizeE2e(root, run, "failed", { ci: true, retain: undefined, artifacts }));
  assert.equal(existsSync(run), true);
});

test("recording and export failures preserve the original run", (t) => {
  const { root, run, artifacts } = fixture(t);
  mkdirSync(join(root, ".generated"));
  writeFileSync(join(root, ".generated/e2e-records"), "blocked destination");
  assert.throws(() => finalizeE2e(root, run, "passed", { ci: true, retain: undefined, artifacts }));
  assert.equal(existsSync(join(run, "evidence.json")), true);
  rmSync(join(root, ".generated/e2e-records"));
  mkdirSync(join(root, ".generated/e2e-evidence/run-one"), { recursive: true });
  assert.throws(() => finalizeE2e(root, run, "passed", { ci: true, retain: undefined, artifacts }));
  assert.equal(existsSync(join(run, "evidence.json")), true);
});

test("an owner retention symlink cannot export outside the artifact directory", (t) => {
  const { root, run, artifacts } = fixture(t);
  mkdirSync(artifacts);
  mkdirSync(join(root, "outside"));
  symlinkSync(join(root, "outside"), join(artifacts, "link"));
  assert.throws(() =>
    finalizeE2e(root, run, "failed", { ci: false, retain: join(artifacts, "link"), artifacts }),
  );
  assert.equal(existsSync(run), true);
});

test("default local failures export their reports and logs before pruning", (t) => {
  const { root, run, artifacts } = fixture(t);
  writeFileSync(join(run, "cloud/cloud.log"), "failed-cloud-startup");
  finalizeE2e(root, run, "failed", { ci: false, retain: undefined, artifacts });
  const retained = join(root, ".generated/e2e-evidence/run-one");
  assert.equal(
    readFileSync(join(retained, "cloud/report/diagnostics/result.json"), "utf8"),
    "synthetic-evidence",
  );
  assert.equal(readFileSync(join(retained, "cloud/cloud.log"), "utf8"), "failed-cloud-startup");
  assert.equal(existsSync(run), false);
});

test("a failed default-local export keeps the original reports and logs", (t) => {
  const { root, run, artifacts } = fixture(t);
  mkdirSync(join(root, ".generated"));
  writeFileSync(join(root, ".generated/e2e-evidence"), "blocked export");
  assert.throws(() =>
    finalizeE2e(root, run, "failed", { ci: false, retain: undefined, artifacts }),
  );
  assert.equal(
    readFileSync(join(run, "cloud/report/diagnostics/result.json"), "utf8"),
    "synthetic-evidence",
  );
});

for (const ancestor of [".upstream", ".upstream/.local", ".upstream/.local/e2e"]) {
  test(`a symlinked run ancestor ${ancestor} cannot escape the prune boundary`, (t) => {
    const { root, run, artifacts } = fixture(t);
    const external = mkdtempSync(join(tmpdir(), "basalt-external-runs-"));
    t.after(() => rmSync(external, { recursive: true, force: true }));
    const moved = join(external, "moved");
    renameSync(join(root, ancestor), moved);
    symlinkSync(moved, join(root, ancestor));
    assert.throws(() =>
      finalizeE2e(root, run, "passed", { ci: false, retain: undefined, artifacts }),
    );
    assert.equal(
      readFileSync(join(run, "cloud/report/diagnostics/result.json"), "utf8"),
      "synthetic-evidence",
    );
  });
}

test("a symlinked checkout root cannot redirect pruning", (t) => {
  const { root, run, artifacts } = fixture(t);
  const alias = `${root}-alias`;
  symlinkSync(root, alias);
  t.after(() => rmSync(alias));
  assert.throws(() =>
    finalizeE2e(alias, join(alias, ".upstream/.local/e2e/run-one"), "passed", {
      ci: false,
      retain: undefined,
      artifacts,
    }),
  );
  assert.equal(existsSync(run), true);
});
