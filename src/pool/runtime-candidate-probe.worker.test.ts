import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { joinedRuntimeProof } from "../../scripts/pool-tests/runtime-handoff-proofs.ts";
import { StartAuthorization } from "./runtime-slots/admission-proof.ts";
import { SlotIdentity } from "./runtime-slots/contract.ts";

async function candidate(f: Awaited<ReturnType<typeof fleetWorkerFixture>>) {
  await f.bootstrap();
  await f.send("fleet-configure", { operationId: "enable", configuration: f.configuration });
  const grant = await f.startGrant();
  const identity = Schema.decodeUnknownSync(SlotIdentity)(
    await f.send("stage", { proof: grant.envelope }),
  );
  const runtime = f.instances.get(identity.instanceId)!.fixture;
  return joinedRuntimeProof(
    runtime,
    f.old.storage,
    Schema.decodeUnknownSync(StartAuthorization)(grant.proof),
  );
}
const status = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(value).status;

test("promotion requires a successful candidate public read and failed public auth cannot create that receipt", async (context) => {
  const f = await fleetWorkerFixture({ candidateColor: "green", publicProbe: true });
  context.after(() => f.cleanup());
  const proof = await candidate(f);
  assert.equal(
    status(await f.send("promote", { intent: await f.intent(), proof: proof.envelope })),
    "refused",
  );
  f.onPublicProbe((request) => f.publicModel(request, undefined));
  assert.equal(
    (await f.command("candidate-probe", { operationId: "invalid-auth", pool: f.claims.pool }))
      .status,
    409,
  );
  const receipt = await f.send("candidate-probe-inspect", { operationId: "invalid-auth" });
  assert.equal(status(receipt), "failed");
  assert.equal(f.probeKeys.keys.length, 0);
  assert.equal(f.publicProbeReads(), 1);
  assert.equal((await f.model()).status, 200);
  assert.equal(
    status(await f.send("promote", { intent: await f.intent(), proof: proof.envelope })),
    "refused",
  );
  f.onPublicProbe((_request, forward) => forward());
  assert.equal(
    status(await f.send("candidate-probe", { operationId: "accepted", pool: f.claims.pool })),
    "accepted",
  );
  assert.equal(f.probeKeys.keys.length, 0);
  assert.equal(
    status(await f.send("promote", { intent: await f.intent(), proof: proof.envelope })),
    "promoted",
  );
});

test("a lost public-read acknowledgement is recovered from its receipt without a second send", async (context) => {
  const f = await fleetWorkerFixture({ candidateColor: "green", publicProbe: true });
  context.after(() => f.cleanup());
  const proof = await candidate(f);
  f.onPublicProbe(async (_request, forward) => {
    const response = await forward();
    await response.body?.cancel();
    throw new Error("synthetic lost public probe reply");
  });
  assert.equal(
    (await f.command("candidate-probe", { operationId: "lost-reply", pool: f.claims.pool })).status,
    409,
  );
  f.reconstruct();
  assert.equal(
    status(await f.send("candidate-probe-inspect", { operationId: "lost-reply" })),
    "accepted",
  );
  assert.equal(
    status(await f.send("candidate-probe", { operationId: "lost-reply", pool: f.claims.pool })),
    "accepted",
  );
  assert.equal(f.publicProbeReads(), 1);
  assert.equal(f.probeKeys.keys.length, 0);
  assert.equal(
    status(await f.send("promote", { intent: await f.intent(), proof: proof.envelope })),
    "promoted",
  );
});
