import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Bun checks deployment source imports; Node checks the shipped JavaScript.
for (const tree of ["src", "lib"])
  test(`the installed Alchemy ${tree} bundler builds the same bytes wherever the checkout and the dependency store sit`, () => {
    execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./fixtures/worker-bundle-location.mjs", import.meta.url)), tree],
      {
        stdio: "pipe",
        timeout: 60_000,
      },
    );
  });
