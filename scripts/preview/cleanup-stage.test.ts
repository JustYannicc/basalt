import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupStage, stateCommandStage } from "./stack/cleanup-stage.ts";

const cli = (...args: string[]) => [
  "bun",
  "alchemy",
  "--log-level",
  "none",
  ...args,
  "--config",
  "c",
];

test("a state read acts for the configured stage, and nothing else can borrow it", () => {
  for (const verb of ["list", "ls", "read", "cat"])
    assert.equal(
      cleanupStage(stateCommandStage, cli("state", verb, "basalt"), "test-pr-7"),
      "test-pr-7",
    );
  // The store-wide writes, and any other command under the placeholder, act for no stage.
  for (const argv of [
    cli("state", "delete", "basalt/production/Database"),
    cli("state", "unsafe", "nuke"),
    cli("deploy", "--stage", stateCommandStage),
    cli("destroy", "--stage", stateCommandStage),
  ])
    assert.equal(cleanupStage(stateCommandStage, argv, "test-pr-7"), "", argv.join(" "));
  // A command that names its stage acts for that stage, as before.
  assert.equal(
    cleanupStage("test-pr-9", cli("destroy", "--stage", "test-pr-9"), "test-pr-7"),
    "test-pr-9",
  );
});
