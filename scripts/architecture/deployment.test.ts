import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { generateDeployment } from "./deployment.ts";
import { stackFingerprint } from "./fingerprint.ts";
import { nativeFixture } from "./native-stack-fixture-helpers.ts";
import { resourceId } from "./native-stack.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()));
const declaration = (extra = "") => `yield* Cloudflare.Worker("Api", {
  main: new URL("./worker.ts", import.meta.url).pathname, ${extra}
});`;

function fixture() {
  const fixture = nativeFixture(join(root, "node_modules"), declaration());
  cleanups.push(fixture.dispose);
  mkdirSync(join(fixture.root, "architecture"));
  const model = join(fixture.root, "architecture/model.c4");
  writeFileSync(model, `
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
  `);
  return { ...fixture, model };
}

test("source-only edits change the fresh fingerprint without changing the generated deployment", async () => {
  const f = fixture();
  const before = await generateDeployment(f.root);
  const fingerprint = stackFingerprint(f.root);
  writeFileSync(join(f.root, "worker.ts"), 'export default { fetch() { return new Response("changed"); } };');
  expect(stackFingerprint(f.root)).not.toBe(fingerprint);
  expect(await generateDeployment(f.root)).toBe(before);
  expect(before).not.toContain("fingerprint");
});

test("binding changes still change the committed deployment digest", async () => {
  const f = fixture();
  const before = await generateDeployment(f.root);
  f.write(declaration('env: { NEW_BINDING: "fixture" },'));
  expect(await generateDeployment(f.root)).not.toBe(before);
});

test("resource and model drift still fail in both directions", async () => {
  const f = fixture();
  // Keep one real declaration so the stale mapping path is exercised.
  f.write('yield* Cloudflare.Worker("Other", { main: new URL("./worker.ts", import.meta.url).pathname });');
  await expect(generateDeployment(f.root)).rejects.toThrow("staleMappings");
  f.write(declaration());
  writeFileSync(f.model, readFileSync(f.model, "utf8").replace(/metadata \{ resources [^}]+\}/, ""));
  await expect(generateDeployment(f.root)).rejects.toThrow("unmodelledResources");
});

test("source changes during generation fail instead of returning a mixed snapshot", async () => {
  const f = fixture();
  const generating = generateDeployment(f.root);
  writeFileSync(join(f.root, "worker.ts"), 'export default { fetch() { return new Response("changed"); } };');
  await expect(generating).rejects.toThrow("Source changed during deployment generation");
});
