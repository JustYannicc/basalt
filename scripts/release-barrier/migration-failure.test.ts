import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandError, CommandTimedOut, UnexpectedExit } from "alchemy/Command/Command";
import { Cause, Effect, Exit } from "effect";
import { fixture } from "./test/deploy-stack-fixture.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";
import { failureCodec } from "./failure-codec.ts";
import { Schema } from "effect";
import { safeProviderFailure } from "./operation-failure.ts";

test("migration command failures retain the registry key and safe cause through receipt and summary", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "migration-failure-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(root, "a".repeat(40));
  const proof = fixture({
    namespace: "eu",
    evidence,
    migrationError: new CommandError({
      command: "node src/migrate.ts",
      reason: new UnexpectedExit({
        exitCode: 1,
        stderr: [
          "Migration step (attempt 1): plan the auth schema",
          'Cloud migration failed at "run hosted migration 19_change_revisions" (attempt 2 of 2): product migration failed: SqlError (SQLSTATE 55P03)',
          'driver: password=SYNTHETIC_SECRET relation="SYNTHETIC_TABLE" account=SYNTHETIC_ID',
        ].join("\n"),
      }),
    }),
  });
  const exit = await Effect.runPromiseExit(proof.effect);
  assert.ok(Exit.isFailure(exit));
  const failure = await evidence.failure(Cause.squash(exit.cause));
  const receipt = proof.receipts.at(-1)!;
  const diagnostic = {
    phase: "run hosted migration 19_change_revisions",
    registry: "hosted",
    migration: "19_change_revisions",
    sqlState: "55P03",
    message: "Migration failed: lock timeout; SQLSTATE 55P03",
  };
  assert.deepEqual(failure.provider, {
    type: "CommandError",
    reason: "UnexpectedExit",
    exitCode: 1,
    migration: diagnostic,
  });
  assert.equal(failure.worker, "Migrations");
  assert.equal(failure.operation, "apply-database-resource");
  assert.deepEqual(receipt.failure?.provider, failure.provider);
  const decoded = Schema.decodeUnknownSync(failureCodec)(receipt.failure);
  assert.deepEqual(decoded.provider, failure.provider);
  assert.deepEqual(receipt.activated, []);
  assert.ok(!proof.events.some((event) => event.startsWith("activate:")));
  const lines: string[] = [];
  const summary = join(root, "summary.md");
  await reportRefusal(failure, summary, (line) => lines.push(line));
  for (const output of [
    JSON.stringify(receipt),
    await readFile(join(root, "failure.json"), "utf8"),
    await readFile(summary, "utf8"),
    ...lines,
  ]) {
    assert.match(output, /19_change_revisions/);
    assert.match(output, /55P03/);
    assert.match(output, /exit(?:Code)?[=": ]+1/);
    assert.doesNotMatch(output, /SYNTHETIC_SECRET|SYNTHETIC_TABLE|SYNTHETIC_ID|password|driver:/);
  }
});

for (const [name, stderr, expected] of [
  [
    "unknown registry and identifiers",
    'Cloud migration failed at "run hosted migration 999_SYNTHETIC_SECRET" (attempt 1 of 2): Error (SQLSTATE 42P01)',
    { phase: "unknown", message: "Migration failed: details unavailable" },
  ],
  [
    "a later attempt clears the earlier SQLSTATE",
    'Cloud migration failed at "apply the auth schema" (attempt 1 of 2): lock timeout (55P03)\nMigration step (attempt 2): open the database sessions\nCloud migration failed at "open the database sessions" (attempt 2 of 2): SYNTHETIC_SECRET',
    { phase: "open the database sessions", message: "Migration failed: details unavailable" },
  ],
  [
    "SDK version without driver payload",
    'Cloud migration failed at "migrate the executor tables" (attempt 1 of 2): product migration failed at executor version 4.0.30: SYNTHETIC_SECRET (SQLSTATE 42P01)',
    {
      phase: "migrate the executor tables",
      version: "4.0.30",
      sqlState: "42P01",
      message: "Migration failed: database error; SQLSTATE 42P01",
    },
  ],
  [
    "step SQLSTATE survives the outer diagnostic wrapper",
    'Migration step (attempt 1): run hosted migration 19_change_revisions\nMigration step failed at "run hosted migration 19_change_revisions": product migration failed: SqlError (SQLSTATE 42P07)\nCloud migration failed at "run hosted migration 19_change_revisions" (attempt 1 of 2): HostedMigrationFailed',
    {
      phase: "run hosted migration 19_change_revisions",
      registry: "hosted",
      migration: "19_change_revisions",
      sqlState: "42P07",
      message: "Migration failed: database error; SQLSTATE 42P07",
    },
  ],
] as const)
  test(`migration diagnostics keep ${name}`, () => {
    const value = safeProviderFailure(
      new CommandError({
        command: "node src/migrate.ts",
        reason: new UnexpectedExit({ exitCode: 1, stderr }),
      }),
    );
    assert.deepEqual(value.migration, expected);
    assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_SECRET/);
    assert.ok(value.migration!.message.length <= 240);
  });

test("outer command timeouts report an unknown exit and do not invent a migration phase", () => {
  const value = safeProviderFailure(
    new CommandError({
      command: "node src/migrate.ts",
      reason: new CommandTimedOut({ timeout: "SYNTHETIC_SECRET" }),
    }),
  );
  assert.equal(value.reason, "CommandTimedOut");
  assert.equal(value.exitCode, null);
  assert.equal(value.migration?.phase, "unknown");
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_SECRET/);
});
