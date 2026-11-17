import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { releaseSettlementFixture } from "./test/release-settlement-fixture.ts";
import { runtimeReleaseState } from "./runtime-release-state.ts";
import { runtimeReleaseJournal } from "./runtime-release-journal.ts";
import { applyReleaseSettlement, planReleaseSettlement } from "./release-settlement-operation.ts";
import { releaseSettlementDigest } from "./release-settlement-contract.ts";

test("settlement proves every retained inactive application has no serving instances", async (context) => {
  const f = await releaseSettlementFixture(context);
  const root = await Effect.runPromise(
    f.provide(f.io.container!(f.record.baseline.applications.root.attributes)),
  );
  const digest = f.record.baseline.applications.root.image.digest;
  const inactive = {
    ...root,
    applicationId: "inactive-application",
    applicationName: "inactive-runtime",
    instances: 0,
  };
  const row = await Effect.runPromise(
    f.memory.get({ stack: f.scope.name, stage: f.scope.stage, fqn: "PoolContainer" }),
  );
  assert.ok(row);
  await Effect.runPromise(
    f.memory.set({
      stack: f.scope.name,
      stage: f.scope.stage,
      fqn: "PoolRuntime",
      value: { ...row, logicalId: "PoolRuntime", fqn: "PoolRuntime", attr: inactive },
    }),
  );
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.sourceCandidate), f.key)),
  );
  const baseline = await Effect.runPromise(f.provide(runtimeReleaseState(f.scope)));
  await journal.write({ ...f.record, baseline });
  let running = false;
  const io = {
    ...f.io,
    container: (target: { accountId: string; applicationId: string }) =>
      Effect.succeed(target.applicationId === inactive.applicationId ? inactive : root),
    forward: {
      ...f.io.forward,
      observation: async (
        target: { accountId: string; applicationId: string; version: number; digest: string },
        token: string,
        signal: AbortSignal,
      ) =>
        target.applicationId === inactive.applicationId
          ? {
              version: inactive.version,
              digest,
              instances: running
                ? [{ id: "0".repeat(64), state: "running" as const, digest, startedAt: 1 }]
                : [],
            }
          : f.io.forward!.observation!(target, token, signal),
    },
  };
  const manifest = await Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: f.sourceCandidate,
          operationId: "settlement-inactive",
          coordinatorGo: "plan",
          expiresAt: Date.now() + 60_000,
        },
        f.provisioningWriter,
        f.key,
        io,
      ),
    ),
  );
  assert.equal(manifest.proof.applications.length, 2);
  running = true;
  await assert.rejects(
    Effect.runPromise(
      f.provide(
        applyReleaseSettlement(
          f.compiled,
          manifest,
          f.key,
          {
            coordinatorGo: "apply",
            writerLease: f.provisioningWriter.lease,
            manifest: releaseSettlementDigest(manifest),
            expiresAt: Date.now() + 60_000,
          },
          io,
        ),
      ),
    ),
    /release-settlement-inactive-application-serving/,
  );
  assert.equal(f.writes(), 0);
});
