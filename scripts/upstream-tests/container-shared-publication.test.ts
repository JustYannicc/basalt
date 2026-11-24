import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("containers built from one context publish to, and run, their own repositories", () => {
  // Deployments use Bun source imports, including TypeScript inside prepared node_modules stores.
  execFileSync(
    "bun",
    [fileURLToPath(new URL("./fixtures/container-shared-publication.mjs", import.meta.url))],
    { stdio: "pipe", timeout: 60_000 },
  );
});
