import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Bun checks deployment source imports; Node checks the shipped JavaScript.
for (const tree of ["src", "lib"])
  test(`the installed Alchemy ${tree} provider names each bare container update by its branch's word`, () => {
    execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./fixtures/container-diff-reason.ts", import.meta.url)), tree],
      { stdio: "pipe", timeout: 60_000 },
    );
  });
