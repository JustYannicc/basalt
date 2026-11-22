import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/cycle-apply.mjs", import.meta.url));
const scenarios = {
  "cross-cycle": "a member of one cycle that reads another cycle uploads once per release",
  "read-back": "a container's new image hash reaches the Worker within one more apply",
};

// Bun checks deployment source imports; Node checks the shipped JavaScript.
for (const tree of ["src", "lib"])
  for (const [scenario, claim] of Object.entries(scenarios))
    test(`the installed Alchemy ${tree} engine: ${claim}`, () => {
      execFileSync(tree === "src" ? "bun" : process.execPath, [fixture, tree, scenario], {
        stdio: "pipe",
        timeout: 30_000,
      });
    });
