import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("a container in a cycle with its Worker is created once, attached, and never deleted to attach", () => {
  // Deployments use Bun source imports, including TypeScript inside prepared node_modules stores.
  execFileSync(
    "bun",
    [fileURLToPath(new URL("./fixtures/container-precreate-no-application.mjs", import.meta.url))],
    { stdio: "pipe", timeout: 60_000 },
  );
});
