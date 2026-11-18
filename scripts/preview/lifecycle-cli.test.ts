import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { PreviewIdentity } from "../environment.ts";
import { ChildProcessFailure } from "../failure/child.ts";
import { liveServices } from "./lifecycle.ts";

test("a failed lifecycle step tells the log why it stopped", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./lifecycle.ts", import.meta.url)), "plan", "not-a-number"],
    { encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Preview lifecycle step failed: Error: /);
  assert.match(
    result.stderr,
    /\n {2}why: It carries no cause, so its message is all that is known\./,
  );
  assert.match(
    result.stderr,
    /\n::error title=Preview lifecycle step failed::Preview lifecycle step failed/,
  );
  assert.match(result.stderr, /\nRemote provider absence is not established\n$/);
});

test("a failed preview deploy keeps the end of what the deploy command printed", async (context) => {
  // The lifecycle's own deploy step, with a `bun` on the path that fails the way the tool does.
  const bin = mkdtempSync(join(tmpdir(), "basalt-preview-bin-"));
  context.after(() => rmSync(bin, { recursive: true, force: true }));
  const token = "cf-token-0123456789abcdef";
  writeFileSync(
    join(bin, "bun"),
    `#!/bin/sh
echo "Plan: 3 to create"
echo "PoolDatabase (Planetscale.Database) create failed" >&2
echo "PlanetscaleApiError: POST https://api.planetscale.com/v1/organizations/acme/databases 422" >&2
echo "  Authorization: $CLOUDFLARE_API_TOKEN" >&2
exit 1
`,
  );
  chmodSync(join(bin, "bun"), 0o755);

  const failure = await liveServices({})
    .deploy(
      { stage: "pr-41" } as PreviewIdentity,
      { PATH: `${bin}:${process.env.PATH}`, CLOUDFLARE_API_TOKEN: token },
      "",
    )
    .then(
      () => assert.fail("The deploy was expected to fail"),
      (error: unknown) => error,
    );

  assert.ok(failure instanceof ChildProcessFailure, String(failure));
  assert.equal(failure.report.exitCode, 1);
  assert.equal(
    failure.message,
    [
      "bun failed with exit 1",
      "Last output lines, credentials removed:",
      "--- stdout",
      "Plan: 3 to create",
      "--- stderr",
      "PoolDatabase (Planetscale.Database) create failed",
      "PlanetscaleApiError: POST [url] 422",
      "  Authorization: [redacted]",
    ].join("\n"),
  );
});
