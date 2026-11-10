import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("first handoff uses the real SDK, encrypted journal and Worker/SQLite in release order", () => {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("./test/first-handoff-scenarios.mjs", import.meta.url))],
    { stdio: "inherit" },
  );
});
