import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fastPlan } from "./ci/fast-plan.ts";

const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");

test("ordinary PRs and local pre-push run the same unconditional preflight with exact commits", () => {
  const workflow = parse(
    readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
  );
  const context = { root: "/fixture", base: "a".repeat(40), head: "b".repeat(40) };
  const plan = fastPlan(workflow, context);
  const preflight = plan.steps.filter((step) => step.command === "node scripts/batch-preflight.ts");
  assert.equal(preflight.length, 1);
  assert.equal(preflight[0]!.env.BASE_SHA, context.base);
  assert.equal(preflight[0]!.env.HEAD_SHA, context.head);
  assert.ok(
    plan.steps.findIndex((step) => step.command.includes("architecture:model")) <
      plan.steps.indexOf(preflight[0]!),
  );
  assert.ok(!plan.steps.some((step) => step.command === "node scripts/ci/style.ts"));
});

test("preflight checks prepared source and shipped types, and every failure stops subsequent work", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "basalt-preflight-")));
  const expected = [
    [".", "scripts/check-git-secrets.ts"],
    [".upstream", "e2e/check-boundary.ts"],
    [".", "scripts/ci/style.ts"],
    [".upstream", "run mcp:apps --check"],
    [".", "scripts/check-connectors.ts --preflight"],
    [".upstream", "run apps:build"],
    [".", "scripts/typecheck.ts"],
  ];
  try {
    for (const path of ["scripts", ".upstream", "bin"]) mkdirSync(join(root, path));
    for (const file of ["batch-preflight.ts", "process.ts"])
      cpSync(new URL("./" + file, import.meta.url), join(root, "scripts", file));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    for (const command of ["node", "bun"])
      writeFileSync(
        join(root, "bin", command),
        `#!/bin/sh\nprintf '%s|%s\\n' "$PWD" "$*" >> "$TRACE"\nif [ "$*" = "$FAIL_COMMAND" ]; then exit 17; fi\n`,
        { mode: 0o755 },
      );
    for (const failure of [undefined, ...expected.map(([, command]) => command)]) {
      const trace = join(root, "trace");
      writeFileSync(trace, "");
      const result = spawnSync(process.execPath, [join(root, "scripts/batch-preflight.ts")], {
        cwd: root,
        env: { ...process.env, PATH: join(root, "bin"), TRACE: trace, FAIL_COMMAND: failure ?? "" },
        encoding: "utf8",
      });
      const count =
        failure === undefined
          ? expected.length
          : expected.findIndex(([, command]) => command === failure) + 1;
      assert.equal(result.status, failure === undefined ? 0 : 1, result.stderr);
      assert.deepEqual(
        readFileSync(trace, "utf8").trim().split("\n"),
        expected.slice(0, count).map(([cwd, command]) => `${join(root, cwd!)}|${command}`),
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
