import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the installed Alchemy provider repairs drift without changing input hashes or rebuilding", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("./fixtures/container-image-drift.mjs", import.meta.url))], {
    stdio: "pipe",
    timeout: 30_000,
  });
});
