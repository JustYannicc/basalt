import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const tree of ["src", "lib"])
  test(`the real ${tree} ContainerProvider stages an immutable image without application writes`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./container-provider-proof.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__CONTAINER_PROOF_PASS__/);
  });
