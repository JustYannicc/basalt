import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const upstream = fileURLToPath(new URL(".upstream/", root));

test("the installed Worker upload provider retains one source-map trailer", () => {
  const provider = readFileSync(
    new URL("node_modules/alchemy/lib/Cloudflare/Workers/WorkerProvider.js", root),
    "utf8",
  );
  assert.equal(provider.match(/^\/\/# sourceMappingURL=/gm)?.length, 1);
});

test("prepared dependency patches pass the canonical strict reverse check", () => {
  execFileSync(process.execPath, ["scripts/check-patches.ts"], {
    cwd: upstream,
    encoding: "utf8",
    stdio: "pipe",
  });
});
