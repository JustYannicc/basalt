import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(
  new URL("./fixtures/framework-reference-location.mjs", import.meta.url),
);

test("the framework reference names no dependency store location", () => {
  execFileSync(process.execPath, [fixture], { stdio: "pipe", timeout: 300_000 });
});
