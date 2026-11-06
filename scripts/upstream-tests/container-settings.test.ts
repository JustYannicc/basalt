import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

for (const tree of ["src", "lib"])
  test(`the carried Alchemy ${tree} comparison respects declared instance ownership`, () => {
    execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./fixtures/container-settings.mjs", import.meta.url)), tree],
      { stdio: "pipe", timeout: 30_000 },
    );
  });
