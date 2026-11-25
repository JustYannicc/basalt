import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// The stub carry 0451 swaps in for AppPages' skill source, run with the cloud app's own Effect.
const require = createRequire(
  new URL("../../.upstream/apps/hosted/cloud/package.json", import.meta.url),
);
const { Cause, Effect, Exit } = require("effect") as typeof import("effect");

test("AppPages' skill source dies loudly instead of parsing", async () => {
  const { prepareAppSkills } = (await import(
    new URL(
      "../../.upstream/apps/hosted/cloud/src/infrastructure/app-pages-skill-source.ts",
      import.meta.url,
    ).href
  )) as {
    prepareAppSkills: (files: ReadonlyArray<unknown>) => import("effect").Effect.Effect<never>;
  };
  const exit = await Effect.runPromiseExit(prepareAppSkills([{ path: "skills/a/SKILL.md" }]));
  assert.ok(Exit.isFailure(exit), "the stub must never succeed");
  // A defect, not a recoverable failure: nothing may catch it and carry on as if skills were empty.
  assert.ok(Cause.hasDies(exit.cause), "the stub must die, not fail");
  assert.match(Cause.pretty(exit.cause), /No skill parsing in app pages/);
});
