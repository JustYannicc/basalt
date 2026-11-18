import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { runtimeFixtureCode } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { storageRestoreNonceKey } from "./storage-bookmark.ts";
import { signEnvelope } from "./token.ts";

const mark = (position: number) =>
  `${position.toString(16).padStart(8, "0")}-00000000-00000000-${"c".repeat(32)}`;

/** The real controller over a storage double that gains the three platform recovery calls. */
async function controller(context: TestContext) {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const calls: string[] = [];
  Object.assign(f.old.storage, {
    getCurrentBookmark: async () => mark(20),
    getBookmarkForTime: async (at: number) => {
      calls.push(`time:${at}`);
      return mark(5);
    },
    onNextSessionRestoreBookmark: async (bookmark: string) => {
      calls.push(`restore:${bookmark}`);
      return mark(900);
    },
  });
  Object.assign(f.old.ctx, {
    abort: (reason: string) => {
      calls.push(`abort:${reason}`);
    },
  });
  const send = async (
    action: string,
    fields: Record<string, unknown> = {},
    key = f.old.env.POOL_DEPLOYMENT_KEY!,
  ) => {
    const at = Date.now();
    return f.worker.runtimeHandoff(
      new Request("http://operations/runtime-handoff", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(key, deploymentReadinessPrefix, {
            controllerCode: runtimeFixtureCode,
            action,
            at,
            expiresAt: at + 30_000,
            ...fields,
          }),
        }),
      }),
    );
  };
  const restore = { target: mark(10), expectedCurrent: mark(20), operator: "fixture-operator" };
  return { f, calls, send, restore };
}

test("a signed bookmark read returns the object's current point", async (context) => {
  const { calls, send } = await controller(context);
  const response = await send("storage-bookmark");
  assert.equal(response.status, 200, await response.clone().text());
  const body = (await response.json()) as { result: { bookmark: string; at: string } };
  assert.equal(body.result.bookmark, mark(20));
  assert.ok(Math.abs(Date.parse(body.result.at) - Date.now()) < 5_000);
  const time = new Date(Date.now() - 3_600_000).toISOString();
  const earlier = await send("storage-bookmark", { time });
  assert.deepEqual(await earlier.json(), { result: { bookmark: mark(5), at: time } });
  assert.deepEqual(calls, [`time:${Date.parse(time)}`]);
  assert.equal((await send("storage-bookmark", { time: "yesterday" })).status, 409);
});

test("bookmark operations need the deployment key, this controller's code and a live envelope", async (context) => {
  const { f, calls, send, restore } = await controller(context);
  assert.equal((await send("storage-bookmark")).status, 200);
  context.mock.method(console, "error", () => {});
  context.mock.method(console, "warn", () => {});
  const fresh = () => ({ ...restore, nonce: crypto.randomUUID() });
  for (const key of ["0".repeat(64), f.old.env.POOL_APP_SIGNING_KEY])
    for (const [action, fields] of [
      ["storage-bookmark", {}],
      ["storage-restore-bookmark", fresh()],
    ] as const)
      assert.ok((await send(action, fields, key)).status >= 400);
  const other = { ...runtimeFixtureCode, candidate: "f".repeat(40) };
  const past = Date.now() - 60_000;
  for (const fields of [
    { controllerCode: other },
    { at: past, expiresAt: past + 30_000 },
    { expiresAt: Date.now() + 45_000 },
  ]) {
    assert.equal((await send("storage-restore-bookmark", { ...fresh(), ...fields })).status, 409);
  }
  assert.equal((await send("storage-bookmark", { controllerCode: other })).status, 409);
  assert.deepEqual(calls, []);
});

test("a signed restore schedules the bookmark, replies with the undo point, then aborts", async (context) => {
  const { f, calls, send, restore } = await controller(context);
  const nonce = crypto.randomUUID();
  const warnings = context.mock.method(console, "warn", () => {});
  /** The rule each refusal named, as the real controller logged it. */
  const refusedBy = () =>
    warnings.mock.calls
      .filter((call) => call.arguments[0] === "POOL_STORAGE_RESTORE_REFUSED")
      .map((call) => JSON.parse(String(call.arguments[1])) as Record<string, string>);
  const unarmed = await send("storage-restore-bookmark", { ...restore, nonce });
  assert.equal(unarmed.status, 409, "a restore without a read from this session is refused");
  assert.equal((await unarmed.json()).cause, "unknown-bookmark");
  assert.deepEqual(refusedBy(), [
    { reason: "unknown-bookmark", nonce, operator: "fixture-operator" },
  ]);
  assert.equal((await send("storage-bookmark")).status, 200);
  context.mock.method(console, "info", () => {});
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const response = await send("storage-restore-bookmark", { ...restore, nonce });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    result: { target: mark(10), live: mark(20), undo: mark(900) },
  });
  assert.deepEqual(calls, [`restore:${mark(10)}`], "the reply leaves before the session ends");
  context.mock.timers.tick(250);
  context.mock.timers.reset();
  assert.deepEqual(calls, [`restore:${mark(10)}`, "abort:storage restore"]);
  assert.ok(await f.old.storage.get(storageRestoreNonceKey(nonce)));
  // This double keeps the object after abort; until the platform ends the session nothing more
  // is read or restored, so a retry cannot replace the scheduled target.
  const read = await send("storage-bookmark");
  assert.equal(read.status, 409);
  assert.equal((await read.json()).cause, "restore-pending");
  const again = await send("storage-restore-bookmark", { ...restore, nonce });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).cause, "restore-pending");
  assert.deepEqual(
    refusedBy().map((line) => line.reason),
    ["unknown-bookmark", "restore-pending"],
  );
  assert.deepEqual(calls, [`restore:${mark(10)}`, "abort:storage restore"]);
});
