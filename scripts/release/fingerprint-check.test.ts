import assert from "node:assert/strict";
import test from "node:test";
import * as Output from "alchemy/Output";
import { Effect, Redacted } from "effect";
import {
  configurationDigest,
  runtimeConfiguration,
} from "../../src/pool/runtime-slots/configuration.ts";
import type { ControllerCode, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import {
  checkRuntimeFingerprint,
  identityUnknownBeforeUpload,
  sealedFingerprint,
  type Sealed,
  type SignedRead,
} from "./fingerprint-check.ts";
import { failureReport } from "./public-report.ts";

/** What the selected runtime was started with: the serving Worker's env, as Worker strings. */
const live = {
  POOL_DATABASE_URL: "postgres://runtime:synthetic-password@db.invalid:6432/basalt_pool",
  POOL_MANAGEMENT_KEY: "synthetic-management-key",
  POOL_APP_SIGNING_KEY: "a".repeat(64),
  POOL_IMAGE_HASH: "0123456789abcdef",
  POOL_CLAUDE_QUOTA_DIAGNOSTIC: "false",
};
// Alchemy plans a value that waits on a command's run as an expression it evaluates at apply.
const pending = Output.literal("hash").pipe(Output.map(() => "ready"));

/** The PoolWorker env as Alchemy plans it: secrets redacted, the readiness hash still pending. */
const declared = (overrides: Record<string, unknown> = {}) => ({
  POOL_DATABASE_URL: Redacted.make(live.POOL_DATABASE_URL),
  POOL_DATABASE_READY: pending,
  POOL_MANAGEMENT_KEY: Redacted.make(live.POOL_MANAGEMENT_KEY),
  POOL_APP_SIGNING_KEY: Redacted.make(live.POOL_APP_SIGNING_KEY),
  POOL_DEPLOYMENT_KEY: Redacted.make("b".repeat(64)),
  POOL_IMAGE_HASH: live.POOL_IMAGE_HASH,
  POOL_DESIRED_IMAGE_INPUT: live.POOL_IMAGE_HASH,
  POOL_CLAUDE_QUOTA_DIAGNOSTIC: "false",
  ...overrides,
});
const plan = (env: Record<string, unknown>) =>
  ({ resources: { PoolWorker: { action: "update", props: { env } } }, deletions: {} }) as never;

const deployed: ControllerCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const target: SlotTarget = {
  format: "pool-runtime-slot-v1",
  controllerId: "e".repeat(64),
  slotId: "blue",
  applicationId: "runtime-application",
  applicationVersion: "7",
  instanceId: "e".repeat(64),
  imageDigest: `sha256:${"f".repeat(64)}`,
  imageInput: live.POOL_IMAGE_HASH,
};

/** The serving controller: it answers only its own code, and seals what admission computed. */
async function controller(options: { selection?: false; fails?: "inspect" | "witness" } = {}) {
  const sealed = await configurationDigest(runtimeConfiguration(live));
  const reads: string[] = [];
  const read: SignedRead = async (action, code, slot) => {
    reads.push(action);
    if (code.candidate !== deployed.candidate || code.workerInput !== deployed.workerInput)
      throw new Error("runtime-handoff-refused: identity");
    if (options.fails === action) throw new Error("bridge closed");
    if (action === "inspect")
      return {
        result: {
          selection:
            options.selection === false
              ? null
              : { active: { target, identity: { ...target, bootId: "boot-1" } } },
        },
      };
    if (slot?.slotId !== target.slotId) throw new Error("unknown slot");
    return {
      result: {
        kind: "witness",
        controllerCode: deployed,
        witness: {
          operationId: "operation-1",
          manifestDigest: "1".repeat(64),
          target,
          configurationFingerprint: sealed,
          launch: { generation: 1, tokenHash: "2".repeat(64) },
          bootId: "boot-1",
        },
      },
    };
  };
  return { read, reads, sealed: () => sealedFingerprint(deployed, read) };
}

const check = (env: Record<string, unknown>, sealed: () => Promise<Sealed>) =>
  Effect.runPromise(checkRuntimeFingerprint(plan(env), "PoolWorker", sealed));
const refusal = (env: Record<string, unknown>, sealed: () => Promise<Sealed>) =>
  Effect.runPromise(Effect.flip(checkRuntimeFingerprint(plan(env), "PoolWorker", sealed)));

test("a planned env with the sealed runtime settings passes", async () => {
  const { reads, sealed } = await controller();
  assert.deepEqual(await check(declared(), sealed), { checked: true });
  assert.deepEqual(reads, ["inspect", "witness"]);
});

for (const [key, value] of [
  ["POOL_MANAGEMENT_KEY", "rotated-management-key"],
  ["POOL_APP_SIGNING_KEY", "9".repeat(64)],
  ["POOL_DATABASE_URL", "postgres://runtime:other-password@db.invalid:6432/basalt_pool"],
] as const)
  test(`a changed ${key} refuses, naming only that the fingerprint differs`, async () => {
    const { sealed } = await controller();
    const error = await refusal(declared({ [key]: Redacted.make(value) }), sealed);
    assert.equal(error._tag, "FingerprintRefused");
    const report = failureReport(error);
    assert.match(report.publicText, /fingerprint differs/u);
    for (const secret of [value, live[key]]) {
      assert.ok(!report.publicText.includes(secret), "the public text names no value");
      assert.ok(!report.detail.includes(secret), "the sealed detail names no value");
    }
  });

test("an unresolved planned setting reports not checked and reads nothing", async () => {
  const { reads, sealed } = await controller();
  const result = await check(declared({ POOL_DATABASE_URL: pending }), sealed);
  assert.equal(result.checked, false);
  assert.match(!result.checked ? result.reason : "", /POOL_DATABASE_URL unresolved in the plan/u);
  assert.deepEqual(reads, []);
});

test("a failed signed read reports not checked", async () => {
  const witness = await controller({ fails: "witness" });
  assert.deepEqual(await check(declared(), witness.sealed), {
    checked: false,
    reason: "the signed witness read failed",
  });
  assert.deepEqual(
    await check(declared(), () => Promise.reject(new Error("bridge failed to open"))),
    { checked: false, reason: "the signed read failed" },
  );
});

test("a read bound to the candidate's code is refused by the serving Worker, so not checked", async () => {
  const { read } = await controller();
  const candidate = { candidate: "3".repeat(40), workerInput: "4".repeat(64) };
  assert.deepEqual(await check(declared(), () => sealedFingerprint(candidate, read)), {
    checked: false,
    reason: "the signed inspect read failed",
  });
});

test("before the upload the deployed controller's identity is unknown, so not checked", async () => {
  assert.deepEqual(await check(declared(), async () => identityUnknownBeforeUpload), {
    checked: false,
    reason: "the deployed controller's identity is not known before the upload",
  });
});

test("without a selected runtime, readiness compares no fingerprint, so not checked", async () => {
  const { sealed } = await controller({ selection: false });
  const result = await check(declared(), sealed);
  assert.equal(result.checked, false);
  assert.match(!result.checked ? result.reason : "", /no runtime is selected/u);
});
