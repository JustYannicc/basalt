import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer } from "../.upstream/node_modules/effect/dist/index.js";
import {
  ChildProcess,
  ChildProcessSpawner,
} from "../.upstream/node_modules/effect/dist/process/index.js";
import { startFixtureControl } from "../.upstream/e2e/sdk/fixtures.ts";

// On a starved CI runner the fixture process takes well past ten seconds to start. While it is alive
// it is still starting, so e2e waits for its ready file until it reports ready or stops (carry 0737).

/** A fixture process that writes its ready file after `seconds`, never, or exits at once. */
const fixture = (behaviour: number | "never" | "exit") =>
  behaviour === "exit"
    ? "process.exit(3)"
    : behaviour === "never"
      ? "setInterval(() => {}, 1000)"
      : `setTimeout(() => require("node:fs").writeFileSync(process.env.TEST_FIXTURE_OUTPUT, JSON.stringify({ origin: "http://127.0.0.1:1" })), ${behaviour * 1000}); setInterval(() => {}, 1000)`;

// The real spawner, with the scenario server swapped for the fixture above; its environment, the
// ready file's path included, is the one startFixtureControl passes.
const spawning = (behaviour: number | "never" | "exit") =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        command._tag === "StandardCommand"
          ? real.spawn(ChildProcess.make("node", ["-e", fixture(behaviour)], command.options))
          : real.spawn(command),
      );
    }),
  );

const start = (behaviour: number | "never" | "exit", readiness?: "3 seconds") => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-fixture-readiness-"));
  return Effect.runPromiseExit(
    Effect.scoped(
      startFixtureControl("http://127.0.0.1:1", directory, "http://127.0.0.1:2", readiness),
    ).pipe(Effect.provide(spawning(behaviour)), Effect.provide(NodeServices.layer)),
  ).finally(() => rmSync(directory, { recursive: true, force: true }));
};

test(
  "a fixture process that reports ready after 15 seconds is ready, not a missing file",
  { timeout: 60_000 },
  async () => {
    const exit = await start(15);
    assert.ok(Exit.isSuccess(exit), String(Exit.isFailure(exit) && exit.cause));
    assert.equal(exit.value.origin, "http://127.0.0.1:1");
  },
);

test(
  "one that never reports ready fails at the bound, naming the cause and its log",
  { timeout: 60_000 },
  async () => {
    const exit = await start("never", "3 seconds");
    assert.ok(Exit.isFailure(exit));
    const message = String(exit.cause);
    assert.match(
      message,
      /Fixture readiness \(the process was still running after 3s with no ready file/,
    );
    assert.match(message, /fixtures\.log/);
  },
);

test("one that stops before reporting ready fails at once", { timeout: 60_000 }, async () => {
  const began = Date.now();
  const exit = await start("exit");
  assert.ok(Exit.isFailure(exit));
  assert.match(String(exit.cause), /stopped before readiness/);
  assert.ok(Date.now() - began < 10_000);
});
