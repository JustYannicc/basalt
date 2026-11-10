import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const tree of ["src", "lib"])
  test(`the real ${tree} SDK creates the runtime once with its final namespace`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./test/provisioning-provider-proof.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__PROVISIONING_PROOF_PASS__/);
  });

for (const tree of ["src", "lib"])
  test(`the complete ${tree} SDK flow preserves the active runtime and performs one final create`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./test/provisioning-cloudflare-flow.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__PROVISIONING_FULL_FLOW_PASS__/);
  });
