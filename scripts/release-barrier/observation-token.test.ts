import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const tree of ["src", "lib"])
  test(`the real ${tree} SDK provisions the exact observation token once, retains its secret natively and refuses unknown replay`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./test/observation-token-proof.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__OBSERVATION_TOKEN_PROOF_PASS__/);
  });

for (const tree of ["src", "lib"])
  test(`the source declaration and production operator provision through the actual ${tree} SDK with encrypted one-shot state`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [
        fileURLToPath(new URL("./test/observation-token-proof.mjs", import.meta.url)),
        tree,
        "source-operation",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__OBSERVATION_TOKEN_SOURCE_OPERATION_PASS__/);
  });
