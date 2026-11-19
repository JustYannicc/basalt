import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { baselineInventory, baselineRoles } from "./baseline-probe.ts";

const scripts = baselineRoles.map((role) => ({
  id: `basalt-${role.toLowerCase()}-production-fixture`,
  tags: ["alchemy:stack:basalt", "alchemy:stage:production", `alchemy:id:${role}`],
}));

test("baseline inventory covers all live roles and refuses missing, duplicate and unexpected Workers", () => {
  assert.deepEqual(
    baselineInventory([...scripts, { id: "unrelated-worker" }]).map((worker) => worker.role),
    baselineRoles,
  );
  assert.ok(baselineInventory(scripts).some((worker) => worker.role === "AppOutbound"));
  const truncated = scripts.map((script) =>
    script.tags.includes("alchemy:id:ArtifactsCredentials")
      ? { ...script, id: `basalt-artifactscredentials-pr${"a".repeat(24)}` }
      : script,
  );
  assert.equal(
    baselineInventory(truncated).find((worker) => worker.role === "ArtifactsCredentials")!
      .scriptName,
    `basalt-artifactscredentials-pr${"a".repeat(24)}`,
  );
  for (const tag of ["alchemy:id:Other", "alchemy:stage:preview", "alchemy:stack:Other"])
    assert.throws(
      () =>
        baselineInventory([
          { ...scripts[0]!, tags: [...scripts[0]!.tags, tag] },
          ...scripts.slice(1),
        ]),
      /Api/,
    );
  assert.throws(
    () => baselineInventory(scripts.filter((script) => !script.id.includes("publicsite"))),
    /PublicSite/,
  );
  assert.throws(() => baselineInventory([...scripts, scripts[0]!]), /Api/);
  assert.throws(
    () =>
      baselineInventory([
        ...scripts,
        {
          id: "basalt-future-worker-production-fixture",
          tags: ["alchemy:stack:basalt", "alchemy:stage:production", "alchemy:id:Future"],
        },
      ]),
    /unexpected/,
  );
});

// Check runs no live probe: pull-request code never receives production credentials.
test("the live probe precedes automatic and manual release work", () => {
  const workflow = (name: string) =>
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8");
  assert.doesNotMatch(workflow("ci"), /baseline-probe-entry\.ts/);
  for (const name of ["release-main", "release-manual"]) {
    const text = workflow(name);
    const probe = text.indexOf("baseline-probe-entry.ts");
    assert.ok(probe > 0 && probe < text.indexOf("release.ts backup-only"), name);
  }
  for (const name of ["deploy", "release-main", "release-manual"]) {
    assert.match(
      workflow(name),
      /BASALT_RELEASE_ATTEMPT="\$\(node -e '[^\n]+randomUUID\(\)[^\n]+'\)" \\\n\s+bun scripts\/release-barrier\/baseline-probe-entry\.ts/,
    );
  }
  const deploy = workflow("deploy");
  assert.ok(deploy.indexOf("baseline-probe-entry.ts") < deploy.indexOf("release.ts deploy "));
});
