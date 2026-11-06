import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Bun checks deployment source imports; Node checks the shipped JavaScript.
for (const tree of ["src", "lib"])
  test(`the installed Alchemy ${tree} provider skips equivalent configurations and repairs real drift`, () => {
    execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./fixtures/container-image-drift.mjs", import.meta.url)), tree],
      {
        stdio: "pipe",
        timeout: 30_000,
      },
    );
  });
