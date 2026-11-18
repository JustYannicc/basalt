import assert from "node:assert/strict";
import { test } from "node:test";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect } from "effect";
import { readOnlyFetch, readOnlyState, releaseTargetFromState } from "./release-target.ts";

const accountId = "1".repeat(32);
const digest = `sha256:${"a".repeat(64)}`;
const worker = {
  status: "updated",
  resourceType: "Cloudflare.Worker",
  logicalId: "PoolWorker",
  attr: { accountId, workerName: "basalt-poolworker-production" },
  props: { env: { POOL_IMAGE_HASH: "0123456789abcdef" } },
};
const container = {
  status: "created",
  resourceType: "Cloudflare.Container",
  logicalId: "PoolContainer",
  attr: {
    accountId,
    applicationId: "root-application",
    version: 7,
    configuration: { image: `registry.cloudflare.com/${accountId}/basalt-pool@${digest}` },
    hash: { image: "fedcba9876543210", digest },
  },
};

const read = (rows: Record<string, unknown>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      for (const [fqn, value] of Object.entries(rows))
        yield* state.set({ stack: "basalt", stage: "production", fqn, value: value as never });
      return yield* releaseTargetFromState(readOnlyState(state), "basalt", "production");
    }),
  );

test("the target and root come from the recorded rows, with POOL_IMAGE_HASH as the input", async () => {
  assert.deepEqual(await read({ PoolWorker: worker, PoolContainer: container }), {
    accountId,
    worker: "basalt-poolworker-production",
    root: {
      applicationId: "root-application",
      applicationVersion: "7",
      imageDigest: digest,
      imageInput: "0123456789abcdef",
    },
  });
});

test("an unsettled worker or a root in another account is refused", async () => {
  await assert.rejects(
    read({ PoolWorker: { ...worker, status: "updating" }, PoolContainer: container }),
    /release-target-worker-unsettled/,
  );
  await assert.rejects(
    read({
      PoolWorker: worker,
      PoolContainer: { ...container, attr: { ...container.attr, accountId: "2".repeat(32) } },
    }),
    /release-target-root-unsettled/,
  );
  await assert.rejects(read({ PoolWorker: worker }), /release-target-root-unsettled/);
});

test("the read-only State refuses every write", async () => {
  await assert.rejects(
    Effect.runPromise(
      Effect.gen(function* () {
        const state = readOnlyState(yield* InMemoryService());
        yield* state.set({ stack: "basalt", stage: "production", fqn: "PoolWorker", value: worker as never });
      }),
    ),
    /release-target-state-write-refused/,
  );
});

test("the read-only fetch admits GETs and State preview auth, nothing else", async () => {
  const seen: string[] = [];
  const guarded = readOnlyFetch(accountId, async (input) => {
    seen.push(new Request(input).method);
    return new Response("{}");
  });
  await guarded("https://api.cloudflare.com/client/v4/accounts/x/workers/scripts");
  await guarded(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain/edge-preview`,
    { method: "POST" },
  );
  await assert.rejects(
    guarded(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/x`, {
      method: "PUT",
    }),
    /release-target-mutation-refused/,
  );
  assert.deepEqual(seen, ["GET", "POST"]);
});
