// Runs Workers in workerd, so it needs `bun install --cwd scripts/startup-profiler --frozen-lockfile`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { measure, median, readBundle } from "../worker-startup.ts";

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

test("work at module scope shows up as startup CPU, in chunks the entry imports", async () => {
  const cheap = await measure(bundle("Cheap", { "worker.js": handler }), 3);
  const costly = await measure(
    bundle("Costly", {
      "worker.js": `import "./setup-Ab12Cd34.js"; ${handler}`,
      "setup-Ab12Cd34.js": eager,
      "unused-Zz99Yy88.js": eager,
    }),
    3,
  );
  assert.ok(median(cheap.startupMs) < 10, `cheap start took ${cheap.startupMs.join(", ")} ms`);
  assert.ok(
    median(costly.startupMs) > median(cheap.startupMs) + 20,
    `costly start took ${costly.startupMs.join(", ")} ms`,
  );
  // The stale chunk is neither uploaded nor counted.
  assert.equal(costly.bytes, Buffer.byteLength(`import "./setup-Ab12Cd34.js"; ${handler}`) + Buffer.byteLength(eager));
});

test("a Worker whose global scope throws fails instead of measuring as cheap", async () => {
  await assert.rejects(
    measure(bundle("Throws", { "worker.js": `throw new Error("no config at startup"); ${handler}` }), 1),
    /Throws failed to start:[\s\S]*no config at startup/,
  );
});
