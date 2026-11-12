import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { homeSchemaRetryAuthorization } from "./home-schema-retry.ts";
import {
  prepareHomeSchema,
  HomeSchemaCommandError,
  type HomeMigrationIdentity,
  type HomeMigrationReceipt,
  type HomeSchemaResult,
} from "./home-schema-operation.ts";
import { readSqlSchemaJournal, writeSqlSchemaJournal } from "./sql-schema-journal.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import { assertSqlSchemas } from "./sql-schema-contract.ts";

const identity: HomeMigrationIdentity = {
  candidate: "a".repeat(40),
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageConfigDigest: `sha256:${"b".repeat(64)}`,
  baselineImageDigest: `sha256:${"c".repeat(64)}`,
  sourceInputHash: "d".repeat(16),
  baselineInputHash: "e".repeat(16),
};
const info = {
  format_version: 1 as const,
  target_version: 2,
  required_indexes: ["idx_usage", "idx_charge"],
};
const initial: HomeSchemaResult = {
  format_version: 1,
  target_version: 2,
  previous_version: null,
  applied_version: 1,
  status: "pending",
  indexes_checked: false,
  pending_indexes: [],
  reason: "schema_pending",
};
const partial: HomeSchemaResult = {
  ...initial,
  applied_version: 2,
  indexes_checked: true,
  pending_indexes: [...info.required_indexes],
  reason: "indexes_pending",
};
const complete: HomeSchemaResult = {
  ...partial,
  status: "ready",
  pending_indexes: [],
  reason: undefined,
};
const failed: HomeSchemaResult = {
  ...partial,
  status: "failed",
  previous_version: 1,
  reason: "migration_failed",
  sqlstate: "57014",
};
const migrated: HomeSchemaResult = { ...complete, status: "migrated", previous_version: 2 };
const manual = { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main" };

test("exact failure acknowledgement is optional and accepted only from the main-only manual dispatch", () => {
  const intent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.equal(homeSchemaRetryAuthorization({}), undefined);
  assert.equal(
    homeSchemaRetryAuthorization({ ...manual, BASALT_HOME_SCHEMA_RETRY_INTENT: "" }),
    undefined,
  );
  assert.equal(
    homeSchemaRetryAuthorization({ ...manual, BASALT_HOME_SCHEMA_RETRY_INTENT: intent }),
    intent,
  );
  for (const source of [
    { ...manual, BASALT_HOME_SCHEMA_RETRY_INTENT: "true" },
    { ...manual, GITHUB_EVENT_NAME: "workflow_run", BASALT_HOME_SCHEMA_RETRY_INTENT: intent },
    { ...manual, GITHUB_REF: "refs/heads/topic", BASALT_HOME_SCHEMA_RETRY_INTENT: intent },
  ])
    assert.throws(
      () => homeSchemaRetryAuthorization(source),
      /home-schema-retry-authorization-invalid/,
    );
});

async function fixture() {
  const state = await Effect.runPromise(InMemoryService());
  const scope = { name: "retry-fixture", stage: "production" };
  const key = "f".repeat(64);
  const run = <A, E>(effect: Effect.Effect<A, E, State>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(State, Effect.succeed(state))));
  const snapshot = readySqlSchemas(identity.candidate);
  const home = snapshot.observations.find((entry) => entry.namespace === "home")!;
  home.expected = ["2"];
  home.applied = ["1"];
  home.pending = ["2"];
  home.status = "pending";
  snapshot.home = undefined;
  let writes = 0;
  const record = async (receipt: HomeMigrationReceipt) => {
    snapshot.candidate = receipt.candidate;
    snapshot.homeMigration = receipt;
    await run(writeSqlSchemaJournal(state, scope, key, snapshot));
  };
  const read = () => run(readSqlSchemaJournal(scope, key));
  const attempt = async (
    options: {
      before?: HomeSchemaResult;
      after?: HomeSchemaResult;
      reply?: HomeSchemaResult;
      identity?: HomeMigrationIdentity;
      retryIntentId?: string;
      failureAt?: string;
      lost?: boolean;
      admit?: boolean;
    } = {},
  ) => {
    const prior = await read();
    const failure = prior?.lastConfirmedFailure;
    let current = options.before ?? partial;
    return prepareHomeSchema({
      identity: options.identity ?? identity,
      info,
      record,
      prior: prior?.unresolvedHome ?? undefined,
      lastFailure: failure && options.failureAt ? { ...failure, at: options.failureAt } : failure,
      retryIntentId: options.retryIntentId,
      admit: () => options.admit ?? true,
      commands: {
        check: async () => current,
        migrate: async (allocated) => {
          await allocated?.("d".repeat(64));
          assert.equal((await read())!.unresolvedHome!.state, "intent");
          writes++;
          current = options.after ?? partial;
          if (options.lost) throw new HomeSchemaCommandError("command-timeout");
          return options.reply ?? failed;
        },
      },
    });
  };
  return { attempt, read, writes: () => writes };
}

test("unchanged failure cannot repeat, exact acknowledgement permits one fresh attempt, and stale acknowledgement cannot repeat its new failure", async () => {
  const f = await fixture();
  const first = await f.attempt({ before: initial });
  assert.equal(first.receipt.state, "failed");
  assert.equal(first.receipt.nativeResult!.status, "failed");
  assert.equal(f.writes(), 1);
  const saved = (await f.read())!;
  assert.equal(saved.unresolvedHome, null);
  assert.equal(saved.lastConfirmedFailure!.intentId, first.receipt.intentId);
  const unchanged = await f.attempt();
  assert.equal(unchanged.receipt.reason, "prior-failure-unchanged");
  assert.equal(unchanged.receipt.priorIntentId, first.receipt.intentId);
  const refusal = readySqlSchemas(identity.candidate);
  const home = refusal.observations.find((entry) => entry.namespace === "home")!;
  home.expected = ["2"];
  home.applied = ["2"];
  refusal.home = unchanged.proof;
  refusal.homeMigration = unchanged.receipt;
  assert.throws(
    () => assertSqlSchemas(refusal, identity.candidate),
    (error) =>
      error instanceof Error &&
      error.message.includes("home: required=2 applied=2") &&
      error.message.includes("native-indexes=idx_usage,idx_charge") &&
      error.message.includes(`prior-intent=${first.receipt.intentId}`),
  );
  const churn = await f.attempt({
    identity: { ...identity, candidate: "b".repeat(40) },
    failureAt: "2026-11-13T00:00:00.000Z",
  });
  assert.equal(churn.receipt.reason, "prior-failure-unchanged");
  assert.equal(
    (await f.attempt({ retryIntentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })).receipt.reason,
    "prior-failure-unchanged",
  );
  assert.equal(
    (await f.attempt({ retryIntentId: "bad" })).receipt.reason,
    "retry-authorization-invalid",
  );
  assert.equal(
    (await f.attempt({ retryIntentId: first.receipt.intentId, admit: false })).receipt.reason,
    "unreviewed-transition",
  );
  assert.equal(f.writes(), 1);
  const second = await f.attempt({
    retryIntentId: first.receipt.intentId,
    reply: { ...failed, previous_version: 2, sqlstate: "42501" },
  });
  assert.equal(second.receipt.state, "failed");
  assert.notEqual(second.receipt.intentId, first.receipt.intentId);
  assert.equal(f.writes(), 2);
  assert.equal(
    (await f.attempt({ retryIntentId: first.receipt.intentId })).receipt.reason,
    "prior-failure-unchanged",
  );
  assert.equal(f.writes(), 2);
  const repaired = await f.attempt({
    retryIntentId: second.receipt.intentId,
    reply: migrated,
    after: complete,
  });
  assert.equal(repaired.receipt.state, "migrated");
  assert.equal(f.writes(), 3);
  const finished = (await f.read())!;
  assert.equal(finished.unresolvedHome, null);
  assert.equal(finished.lastConfirmedFailure!.intentId, second.receipt.intentId);
  assert.equal(finished.lastConfirmedFailure!.nativeResult!.sqlstate, "42501");
  assert.equal((await f.attempt({ before: complete })).receipt.state, "skipped");
  assert.equal(f.writes(), 3);
});

test("observable index progress permits a fresh reviewed completion, while acknowledgement cannot bypass an unknown write", async () => {
  const progress = await fixture();
  await progress.attempt({ before: initial });
  const repaired = await progress.attempt({
    before: { ...partial, pending_indexes: ["idx_charge"] },
    reply: migrated,
    after: complete,
  });
  assert.equal(repaired.receipt.state, "migrated");
  assert.equal(progress.writes(), 2);
  const unknown = await fixture();
  const lost = await unknown.attempt({ before: initial, lost: true });
  assert.equal(lost.receipt.state, "unknown");
  assert.equal(
    (await unknown.attempt({ retryIntentId: lost.receipt.intentId })).receipt.reason,
    "prior-intent-unsettled",
  );
  assert.equal(unknown.writes(), 1);
});
