import * as NodeServices from "@effect/platform-node/NodeServices";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { Data, Effect, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { copyE2eEvidence } from "../e2e-evidence.ts";

import { productionOpsDatabaseFixture } from "../../.upstream/e2e/support/production-ops-database-fixture.ts";
import { cloudRuntimeControl } from "../../.upstream/e2e/support/cloud-runtime-control.ts";
import { cloudLogActivity } from "../../.upstream/e2e/support/cloud-log-activity.ts";
import { fixtureProcessOutput } from "../../.upstream/e2e/support/fixture-diagnostics.ts";

class FixtureControlError extends Data.TaggedError("FixtureControlError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

test("a failed readiness child retains both streams, its exit code and the control cause", async (t) => {
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "physical-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "cloud");
  await mkdir(directory);
  const stdout = "readiness child stdout\n";
  const stderr = "readiness child stderr: inner SQL failure\n";
  const complete = { pending: 0, failed: 0, completed: 1, observedPending: 2 };
  let result = { stdout, stderr, exitCode: 17 };
  let forcedExit: number | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = ChildProcessSpawner.ChildProcessSpawner.of({
          ...native,
          exitCode: (command) =>
            command._tag === "StandardCommand" && command.command === "docker"
              ? Effect.succeed(ChildProcessSpawner.ExitCode(0))
              : native.exitCode(command),
          string: (command) =>
            command._tag === "StandardCommand" && command.command === "docker"
              ? Effect.succeed("")
              : native.string(command),
          spawn: (command) => {
            if (command._tag === "StandardCommand" && command.command === "docker")
              return native.spawn(
                ChildProcess.make(
                  process.execPath,
                  [
                    "-e",
                    command.args[0] === "port"
                      ? 'process.stdout.write("127.0.0.1:15432\\n")'
                      : "",
                  ],
                  { stdout: "pipe", stderr: "pipe" },
                ),
              );
            if (
              command._tag === "StandardCommand" &&
              command.args.includes("apps/hosted/testing/production-ops-provisioning-fixture.ts")
            )
              return native
                .spawn(
                  ChildProcess.make(
                    process.execPath,
                    [
                      "-e",
                      `process.stdout.write(${JSON.stringify(result.stdout)}); process.stderr.write(${JSON.stringify(result.stderr)}); process.exitCode = ${result.exitCode};`,
                    ],
                    { stdout: "pipe", stderr: "pipe" },
                  ),
                )
                .pipe(
                  Effect.map((handle) => ({
                    ...handle,
                    exitCode: handle.exitCode.pipe(
                      Effect.tap((code) =>
                        Effect.sync(() => {
                          forcedExit = code;
                        }),
                      ),
                    ),
                  })),
                );
            return native.spawn(command);
          },
        });
        const fixture = yield* productionOpsDatabaseFixture({
          container: "synthetic-no-docker-execution",
          databasePassword: "fixture-only",
          runtimePassword: "fixture-only",
          directory,
          dockerEnv: {
            PATH: process.env.PATH ?? "",
            DOCKER_HOST: "unused",
            DOCKER_CONFIG: "unused",
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        const control = yield* cloudRuntimeControl(
          { origin: "http://unused.invalid", token: Redacted.make("fixture-control-only") },
          yield* cloudLogActivity,
          (binding) =>
            Effect.gen(function* () {
              if (binding === "original")
                return yield* new FixtureControlError({
                  message: "outer fixture error",
                  cause: new Error("middle fixture error", {
                    cause: Object.assign(new Error("root fixture error"), { code: "XX000" }),
                  }),
                });
              return yield* fixture.provisioned.pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.as({ ready: true }),
              );
            }),
          directory,
        );
        const request = (binding: string) =>
          Effect.promise(() =>
            fetch(`${control.origin}/runtime/database-binding`, {
              method: "POST",
              headers: {
                authorization: "Bearer fixture-control-only",
                "content-type": "application/json",
              },
              body: JSON.stringify({ binding }),
            }),
          );
        const response = yield* request("provisioned");
        assert.equal(response.status, 503);
        assert.deepEqual(yield* Effect.promise(() => response.json()), {
          error: "runtime_control_failed",
        });
        assert.equal(forcedExit, 17, "the fixture must observe the forced child failure");
        const nested = yield* request("original");
        assert.equal(nested.status, 503);
        assert.deepEqual(yield* Effect.promise(() => nested.json()), {
          error: "runtime_control_failed",
        });
        result = {
          stdout: JSON.stringify(complete),
          stderr: "successful child diagnostics\n",
          exitCode: 0,
        };
        const success = yield* request("provisioned");
        assert.equal(success.status, 200, "diagnostics must preserve successful readiness");
        assert.deepEqual(yield* Effect.promise(() => success.json()), { ready: true });
        assert.deepEqual(
          JSON.parse(
            yield* Effect.promise(() =>
              readFile(join(directory, "physical-provisioning-completed.json"), "utf8"),
            ),
          ),
          complete,
        );
        result = {
          stdout: "invalid readiness JSON\n",
          stderr: "decode failure diagnostics\n",
          exitCode: 0,
        };
        const malformed = yield* request("provisioned");
        assert.equal(malformed.status, 503, "diagnostics must not accept malformed readiness");
        assert.deepEqual(yield* Effect.promise(() => malformed.json()), {
          error: "runtime_control_failed",
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
  );
  const evidence = join(root, "retained");
  copyE2eEvidence(directory, evidence);
  const diagnosticDirectory = join(evidence, "report/diagnostics");
  const files = await readdir(diagnosticDirectory).catch(() => []);
  const contents = await Promise.all(
    files.map((file) => readFile(join(diagnosticDirectory, file), "utf8")),
  );
  assert.ok(
    contents.some((text) => text === stdout),
    "the failed child's stdout must survive evidence collection",
  );
  assert.ok(
    contents.some((text) => text === stderr),
    "the failed child's stderr must survive evidence collection",
  );
  assert.ok(
    contents.some((text) => text.includes('"exitCode":17')),
    "the actual exit code must be retained",
  );
  assert.ok(
    contents.some((text) => text.includes("ProductionDatabaseFixtureFailed")),
    "the runtime-control cause must survive its generic HTTP response",
  );
  assert.ok(
    contents.some((text) =>
      ["outer fixture error", "middle fixture error", "root fixture error", "XX000"].every((part) =>
        text.includes(part),
      ),
    ),
    "the complete tagged cause chain and SQLSTATE must survive collection",
  );
  assert.ok(
    contents.some((text) => text === "invalid readiness JSON\n"),
    "a successful exit must not hide output that fails readiness decoding",
  );
});

test("unwritable diagnostics preserve the child's output and exit status", async (t) => {
  const directory = await mkdtemp(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "physical-diagnostics-unwritable-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "report"), "A file prevents diagnostic directory creation.");
  for (const exitCode of [0, 17]) {
    const result = await Effect.runPromise(
      Effect.scoped(
        fixtureProcessOutput(
          directory,
          ChildProcess.make(
            process.execPath,
            ["-e", `process.stdout.write("original output"); process.exitCode = ${exitCode};`],
            { stdout: "pipe", stderr: "pipe" },
          ),
        ),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.deepEqual(result, { stdout: "original output", exitCode });
  }
});
