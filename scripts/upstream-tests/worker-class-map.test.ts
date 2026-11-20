import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Bun checks deployment source imports; Node checks the shipped JavaScript.
for (const tree of ["src", "lib"])
  test(`the installed Alchemy ${tree} Worker provider keeps its own classes readable beside another Worker's class`, () => {
    execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./fixtures/worker-class-map.mjs", import.meta.url)), tree],
      {
        stdio: "pipe",
        timeout: 30_000,
      },
    );
  });
