import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const fixture = fileURLToPath(new URL("./fixtures/web-build-location.mjs", import.meta.url));

// Bun runs the dashboard's TypeScript build options as the web build does.
test("the dashboard's server build is the same bytes from any dependency store", () => {
  execFileSync("bun", [fixture], { stdio: "pipe", timeout: 120_000 });
});
