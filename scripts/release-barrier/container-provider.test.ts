import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const tree of ["src", "lib"])
  test(`the real ${tree} ContainerProvider stages an immutable image without application writes`, () => {
    const output = execFileSync(
      tree === "src" ? "bun" : process.execPath,
      [fileURLToPath(new URL("./test/container-provider-proof.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__CONTAINER_PROOF_PASS__/);
  });

for (const tree of ["src", "lib"])
  test(`the real ${tree} publication hash reaches Home admission without another hash algorithm`, () => {
    const output = execFileSync(
      "bun",
      [fileURLToPath(new URL("./test/provider-admission-proof.mjs", import.meta.url)), tree],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__PROVIDER_ADMISSION_PASS__/);
  });

for (const tree of ["src", "lib"])
  test(`the real ${tree} publication reaches Home admission from the b75 baseline`, () => {
    const output = execFileSync(
      "bun",
      [
        fileURLToPath(new URL("./test/provider-admission-proof.mjs", import.meta.url)),
        tree,
        "",
        "",
        "c7646255244ef2e0",
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    assert.match(output, /__PROVIDER_ADMISSION_PASS__/);
  });
