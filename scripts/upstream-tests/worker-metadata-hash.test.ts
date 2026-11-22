import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/worker-metadata-hash.mjs", import.meta.url));

// Bun checks deployment source imports; Node checks the shipped JavaScript.
for (const tree of ["src", "lib"])
  test(`the installed Alchemy ${tree} Worker metadata hash covers only what the upload carries`, () => {
    execFileSync(tree === "src" ? "bun" : process.execPath, [fixture, tree], {
      stdio: "pipe",
      timeout: 30_000,
    });
  });
