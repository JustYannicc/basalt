import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("a cyclic container redeploy propagates publication outputs without changing no-op or drift behavior", () => {
  // Deployments use Bun source imports, including TypeScript inside prepared node_modules stores.
  execFileSync(
    "bun",
    [fileURLToPath(new URL("./fixtures/container-publication-cycle.mjs", import.meta.url))],
    { stdio: "pipe", timeout: 30_000 },
  );
});
