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

for (const tree of ["src", "lib"])
  for (const name of ["PoolRuntimeBlue", "PoolRuntimeGreen"]) {
    test(`the real ${tree} SDK provisions ${name} once with its exact namespace and four-instance cap`, () => {
      const output = execFileSync(
        tree === "src" ? "bun" : process.execPath,
        [
          fileURLToPath(new URL("./test/provisioning-provider-proof.mjs", import.meta.url)),
          tree,
          name,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.match(output, /__PROVISIONING_PROOF_PASS__/);
    });
    test(`the complete ${tree} SDK flow provisions only ${name} and preserves the live baseline`, () => {
      const output = execFileSync(
        tree === "src" ? "bun" : process.execPath,
        [
          fileURLToPath(new URL("./test/provisioning-cloudflare-flow.mjs", import.meta.url)),
          tree,
          name,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.match(output, /__PROVISIONING_FULL_FLOW_PASS__/);
    });
  }

for (const tree of ["src", "lib"])
  for (const resource of ["PoolRuntimeBlue", "PoolRuntimeGreen"])
    test(`the evaluated source ${resource} declaration provisions through the actual ${tree} SDK and retains its downstream state`, () => {
      const output = execFileSync(
        tree === "src" ? "bun" : process.execPath,
        [
          fileURLToPath(new URL("./test/provisioning-cloudflare-flow.mjs", import.meta.url)),
          tree,
          resource,
          "source",
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      assert.match(output, /__PROVISIONING_FULL_FLOW_PASS__/);
    });

for (const tree of ["src", "lib"])
  test(`evaluated source drift refuses before the ${tree} SDK performs namespace work`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [
        fileURLToPath(new URL("./test/provisioning-cloudflare-flow.mjs", import.meta.url)),
        tree,
        "PoolRuntimeBlue",
        "source-drift",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__PROVISIONING_SOURCE_REFUSED_BEFORE_IO__/);
  });
