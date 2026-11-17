import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { joinedRuntimeProof } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { StartAuthorization } from "./runtime-slots/admission-proof.ts";
import { SlotIdentity } from "./runtime-slots/contract.ts";
import { crashAuditKey } from "./runtime-crash-contract.ts";

test(
  "a remote selected primary is killed and audited only inside its owning runtime DO",
  { timeout: 20_000 },
  async (context) => {
    const f = await fleetWorkerFixture({ candidateColor: "green", publicProbe: true });
    context.after(f.cleanup);
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "remote-crash-fleet",
      configuration: { ...f.configuration, targetActive: 100 },
    });
    const grant = await f.startGrant();
    const staged = await f.stage(grant.envelope);
    assert.equal(staged.status, 200, await staged.clone().text());
    const identity = Schema.decodeUnknownSync(Schema.Struct({ result: SlotIdentity }))(
      await staged.json(),
    ).result;
    const primary = f.instances.get(identity.instanceId)!.fixture;
    const proof = await joinedRuntimeProof(
      primary,
      f.old.storage,
      Schema.decodeUnknownSync(StartAuthorization)(grant.proof),
    );
    await f.send("candidate-probe", { operationId: "remote-crash-probe", pool: f.claims.pool });
    const promoted = await f.send("promote", { intent: await f.intent(), proof: proof.envelope });
    assert.equal(
      Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(promoted).status,
      "promoted",
    );
    await f.send("drain", { operationId: "remote-crash-drain" });
    await f.settle();
    assert.equal((await f.inspect()).selection.draining, undefined);
    const initial = await f.model();
    assert.equal(initial.status, 200);
    await initial.body?.cancel();
    await f.settle();
    await f.resourcesWhen((rows) => rows.some((row) => row.phase === "ready"));
    const at = Date.now();
    const nonce = crypto.randomUUID();
    const response = await f.command("runtime-crash", {
      identity,
      nonce,
      operator: "fixture-operator",
      at,
      expiresAt: at + 30_000,
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(primary.calls.signals, [9]);
    assert.deepEqual(f.old.calls.signals, []);
    assert.equal(await f.old.storage.get(crashAuditKey(nonce)), undefined);
    assert.ok(await primary.storage.get(crashAuditKey(nonce)));
    const inspection = await f.command("runtime-crash-inspect", { identity, nonce });
    assert.equal(inspection.status, 200);
    const observed = Schema.decodeUnknownSync(
      Schema.Struct({
        result: Schema.Struct({
          target: Schema.Struct({ audit: Schema.Unknown, ready: Schema.Boolean }),
        }),
      }),
    )(await inspection.json());
    assert.ok(observed.result.target.audit);
    assert.equal(observed.result.target.ready, false);
    f.reconstruct();
    await f.upkeep();
    await f.settle();
    assert.equal(primary.ctx.container.running, true);
    assert.notEqual(primary.identity().bootId, identity.bootId);
    assert.equal(primary.calls.start, 2, "one original stage plus one automatic restart");
    const after = await f.model();
    assert.equal(after.status, 200);
    await after.body?.cancel();
  },
);
