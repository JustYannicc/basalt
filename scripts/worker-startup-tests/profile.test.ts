// Runs Workers in workerd, so it needs `bun install --cwd scripts/startup-profiler --frozen-lockfile`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { InconclusiveStartup, measure, median, readBundle } from "../worker-startup.ts";

const root = mkdtempSync(join(tmpdir(), "worker-startup-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const bundle = (name: string, modules: Record<string, string>) => {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  for (const [file, source] of Object.entries(modules)) writeFileSync(join(directory, file), source);
  return readBundle(name, directory);
};

const handler = "export default { fetch() { return new Response('ok'); } };";
// Work at module scope, like eager schema construction: workerd freezes clocks, so loop instead.
const eager = `let x = 0; for (let i = 0; i < 60_000_000; i++) x = (x + i * 7) % 1_000_003; globalThis.x = x;`;

test("work at module scope shows up as startup CPU, in the chunk the entry imports", async () => {
  // The chunk runs only when imported, so samples in it prove the entry's import was profiled.
  let inSetup = 0;
  const costly = await measure(
    bundle("Costly", {
      "worker.js": `import "./setup-Ab12Cd34.js"; ${handler}`,
      "setup-Ab12Cd34.js": eager,
      "unused-Zz99Yy88.js": eager,
    }),
    3,
    {
      onProfile: (profile) => {
        const setup = new Set(
          profile.nodes.filter((node) => (node.callFrame as { url?: string }).url?.endsWith("setup-Ab12Cd34.js")).map((node) => node.id),
        );
        inSetup += profile.samples.filter((id) => setup.has(id)).length;
      },
    },
  );
  // About 175 ms on a laptop and 500 ms on a CI runner; far above any profiler noise.
  assert.ok(median(costly.startupMs) > 50, `costly start took ${costly.startupMs.join(", ")} ms`);
  assert.ok(inSetup > 0, "no samples landed in the imported chunk");
  // The stale chunk is neither uploaded nor counted.
  assert.equal(costly.bytes, Buffer.byteLength(`import "./setup-Ab12Cd34.js"; ${handler}`) + Buffer.byteLength(eager));
});

test("a start with almost no work of its own still measures, as cheap", async (t) => {
  // Nothing here depends on the Worker's own code being sampled: the witnesses prove coverage.
  // A runner that starves the sampler on every retry makes this unknowable, which isn't a failure.
  const cheap = await measure(bundle("Cheap", { "worker.js": handler }), 3).catch((error) => {
    if (error instanceof InconclusiveStartup) return t.skip(error.message);
    throw error;
  });
  if (!cheap) return;
  assert.equal(cheap.startupMs.length, 3);
  assert.ok(median(cheap.startupMs) < 50, `cheap start took ${cheap.startupMs.join(", ")} ms`);
});

test("a Worker whose global scope throws fails instead of measuring as cheap", async () => {
  await assert.rejects(
    measure(bundle("Throws", { "worker.js": `throw new Error("no config at startup"); ${handler}` }), 1),
    /Throws failed to start:[\s\S]*no config at startup/,
  );
});
