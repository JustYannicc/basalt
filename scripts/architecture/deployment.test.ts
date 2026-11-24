import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { generateDeployment } from "./deployment.ts";
import { stackFingerprint } from "./fingerprint.ts";
import { nativeFixture } from "./native-stack-fixture-helpers.ts";
import { resourceId } from "./native-stack.ts";
import { readGeneratedInventory } from "./generated-inventory.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cleanups: (() => void)[] = [];
afterAll(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
// Each scenario evaluates the fixture stack in a subprocess, once or twice. That slow setup runs
// in the scenario's beforeAll, as fitness.test.ts does, so its tests only assert what it saw.
const stackEvaluation = 40_000;
const declaration = (extra = "") => `yield* Cloudflare.Worker("Api", {
  main: new URL("./worker.ts", import.meta.url).pathname, ${extra}
});`;
const changedWorker = 'export default { fetch() { return new Response("changed"); } };';
const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  );

function fixture() {
  const fixture = nativeFixture(join(root, "node_modules"), declaration());
  cleanups.push(fixture.dispose);
  mkdirSync(join(fixture.root, "architecture"));
  const model = join(fixture.root, "architecture/model.c4");
  writeFileSync(
    model,
    `
    specification {
      element module
      deploymentNode stage
      deploymentNode zone
      deploymentNode worker
    }
    model {
      api = module "API" {
        metadata { resources "${resourceId("Cloudflare.Worker", "Api")}" }
      }
    }
  `,
  );
  return { ...fixture, model };
}

/** Two generations around a source-only edit, and what the inventory and fingerprint read. */
async function sourceOnlyEdit() {
  const f = fixture();
  const before = readGeneratedInventory(f.root);
  const first = await generateDeployment(f.root);
  const inventory = readGeneratedInventory(f.root);
  const fingerprint = stackFingerprint(f.root);
  writeFileSync(join(f.root, "worker.ts"), changedWorker);
  const edited = stackFingerprint(f.root);
  const afterEdit = readGeneratedInventory(f.root);
  const second = await generateDeployment(f.root);
  const regenerated = readGeneratedInventory(f.root);
  return { before, first, inventory, fingerprint, edited, afterEdit, second, regenerated };
}

describe("source-only edits", () => {
  let seen: Awaited<ReturnType<typeof sourceOnlyEdit>>;
  beforeAll(async () => {
    seen = await sourceOnlyEdit();
  }, stackEvaluation);

  test("change the fresh fingerprint without changing the generated deployment", () => {
    expect(seen.before).toBeUndefined();
    expect(seen.inventory).toEqual([
      {
        id: resourceId("Cloudflare.Worker", "Api"),
        kind: "Worker",
        source: "alchemy.run.ts",
        declaredName: "Api",
      },
    ]);
    expect(seen.edited).not.toBe(seen.fingerprint);
    expect(seen.afterEdit).toBeUndefined();
    expect(seen.second).toBe(seen.first);
    expect(seen.regenerated).toEqual(seen.inventory);
    expect(seen.first).not.toContain("fingerprint");
  });
});

describe("binding changes", () => {
  const seen = { before: "", after: "" };
  beforeAll(async () => {
    const f = fixture();
    seen.before = await generateDeployment(f.root);
    f.write(declaration('env: { NEW_BINDING: "fixture" },'));
    seen.after = await generateDeployment(f.root);
  }, stackEvaluation);

  test("still change the committed deployment digest", () => {
    expect(seen.after).not.toBe(seen.before);
  });
});

describe("generated inventory", () => {
  let f: ReturnType<typeof fixture>;
  beforeAll(async () => {
    f = fixture();
    await generateDeployment(f.root);
  }, stackEvaluation);

  test("rejects a different evaluator and malformed resource metadata", () => {
    const path = join(f.root, ".generated/architecture/stack-inventory.json");
    const valid = readFileSync(path, "utf8");
    writeFileSync(path, valid.replace(/"tooling":"[a-f0-9]+"/, '"tooling":"outdated"'));
    expect(readGeneratedInventory(f.root)).toBeUndefined();
    writeFileSync(path, valid.replace(/"id":"resource-[a-f0-9]+"/, '"id":"invalid"'));
    expect(() => readGeneratedInventory(f.root)).toThrow("Invalid generated stack inventory");
  });
});

describe("resource and model drift", () => {
  const seen: { stale?: unknown; unmodelled?: unknown } = {};
  beforeAll(async () => {
    const f = fixture();
    // Keep one real declaration so the stale mapping path is exercised.
    f.write(
      'yield* Cloudflare.Worker("Other", { main: new URL("./worker.ts", import.meta.url).pathname });',
    );
    seen.stale = await failure(generateDeployment(f.root));
    f.write(declaration());
    writeFileSync(
      f.model,
      readFileSync(f.model, "utf8").replace(/metadata \{ resources [^}]+\}/, ""),
    );
    seen.unmodelled = await failure(generateDeployment(f.root));
  }, stackEvaluation);

  test("still fail in both directions", () => {
    expect(seen.stale).toHaveProperty("message", expect.stringContaining("staleMappings"));
    expect(seen.unmodelled).toHaveProperty(
      "message",
      expect.stringContaining("unmodelledResources"),
    );
  });
});

describe("source changes during generation", () => {
  const seen: { error?: unknown } = {};
  beforeAll(async () => {
    const f = fixture();
    const generating = generateDeployment(f.root);
    writeFileSync(join(f.root, "worker.ts"), changedWorker);
    seen.error = await failure(generating);
  }, stackEvaluation);

  test("fail instead of returning a mixed snapshot", () => {
    expect(seen.error).toHaveProperty(
      "message",
      expect.stringContaining("Source changed during deployment generation"),
    );
  });
});
