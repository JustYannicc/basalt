import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { runtimeConfiguration } from "../../src/pool/runtime-slots/configuration.ts";
import { nativeMembershipKey } from "../../src/pool/runtime-slots/storage.ts";
import { runtimeReleaseClientFixture as fixture } from "./test/runtime-release-client-fixture.ts";

test(
  "the ordinary release client stages, joins real provider reads, proves public serving and promotes once",
  { timeout: 15_000 },
  async (context) => {
    const f = await fixture();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reading: Promise<string> | undefined;
    context.after(async () => {
      try {
        body?.close();
      } catch {}
      await reading?.catch(() => {});
      await f.cleanup();
    });
    f.onModel(async (_runtime, request) =>
      new URL(request.url).searchParams.has("held")
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
                controller.enqueue(new TextEncoder().encode("old:"));
              },
            }),
          )
        : undefined,
    );
    const old = await f.model(new Request("https://pool.invalid/v1/models?held=1"));
    reading = old.text();
    await f.client.promote("green-application", "ordinary-release", f.claims.pool);
    assert.equal(f.publicProbeReads(), 1);
    assert.equal(f.probeKeys.keys.length, 0);
    assert.equal(f.commands.filter((action) => action === "stage").length, 1);
    assert.equal(f.commands.filter((action) => action === "promote").length, 1);
    assert.equal(
      (await f.client.inspect()).selection!.active.target.applicationId,
      "green-application",
    );
    assert.equal(
      await f.client.selectedCurrent(
        f.candidate.target.imageInput,
        runtimeConfiguration(f.candidate.env),
      ),
      true,
    );
    assert.equal(
      await f.client.selectedCurrent(f.candidate.target.imageInput, {
        ...runtimeConfiguration(f.candidate.env),
        managementKey: "other-synthetic-key",
      }),
      false,
    );
    assert.equal(f.old.calls.destroy, 0);
    body!.enqueue(new TextEncoder().encode("terminal"));
    body!.close();
    assert.equal(await reading, "old:terminal");
    f.reconstructRoot();
    assert.ok(await f.client.health());
    assert.equal(f.closes(), f.commands.length);
  },
);

test(
  "a refused public candidate read keeps the old selected runtime serving",
  { timeout: 15_000 },
  async (context) => {
    const f = await fixture("public");
    context.after(() => f.cleanup());
    await assert.rejects(
      f.client.promote("green-application", "public-refused", f.claims.pool),
      /runtime-handoff-response-refused/,
    );
    assert.equal(f.commands.filter((action) => action === "promote").length, 0);
    assert.equal(f.publicProbeReads(), 1);
    assert.equal(
      (await f.client.inspect()).selection!.active.identity!.bootId,
      f.old.identity().bootId,
    );
    const response = await f.model();
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(f.probeKeys.keys.length, 0);
  },
);

test(
  "successive ordinary handoffs alternate applications and preserve the previously selected runtime's held response",
  { timeout: 15_000 },
  async (context) => {
    const f = await fixture();
    let body: ReadableStreamDefaultController<Uint8Array> | undefined;
    let reading: Promise<string> | undefined;
    context.after(async () => {
      try {
        body?.close();
      } catch {}
      await reading?.catch(() => {});
      await f.cleanup();
    });
    await f.client.promote("green-application", "first-ordinary-release", f.claims.pool);
    await f.send("drain", { operationId: "drain-original-primary" });
    assert.equal((await f.client.inspect()).selection?.draining, undefined);
    assert.equal(f.old.calls.destroy, 1);
    const green = [...f.instances.values()].find((instance) => instance.color === "green")!;
    f.onModel(async (_runtime, request) =>
      new URL(request.url).searchParams.has("held")
        ? new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                body = controller;
                controller.enqueue(new TextEncoder().encode("green:"));
              },
            }),
          )
        : undefined,
    );
    const held = await f.model(new Request("https://pool.invalid/v1/models?held=1"));
    reading = held.text();
    await f.client.promote("blue-application", "second-ordinary-release", f.claims.pool);
    assert.equal(
      (await f.client.inspect()).selection!.active.target.applicationId,
      "blue-application",
    );
    assert.equal(green.fixture.calls.destroy, 0);
    f.reconstructRoot();
    assert.ok(await f.client.health());
    body!.enqueue(new TextEncoder().encode("terminal"));
    body!.close();
    assert.equal(await reading, "green:terminal");
    await f.settle();
    await f.send("drain", { operationId: "drain-green-primary" });
    assert.equal(green.fixture.calls.destroy, 1);
    assert.equal((await f.client.inspect()).selection?.draining, undefined);
    assert.equal(f.commands.filter((action) => action === "stage").length, 2);
    assert.equal(f.commands.filter((action) => action === "promote").length, 2);
    assert.equal(f.publicProbeReads(), 2);
    assert.equal(f.probeKeys.keys.length, 0);
  },
);

for (const fault of ["stage", "promote"] as const)
  test(
    `a lost ${fault} reply reconstructs and reads the committed state without repeating that mutation`,
    { timeout: 15_000 },
    async (context) => {
      const f = await fixture(fault);
      context.after(() => f.cleanup());
      if (fault === "stage")
        await f.client.promote("green-application", "lost-reply", f.claims.pool);
      else
        await assert.rejects(
          f.client.promote("green-application", "lost-reply", f.claims.pool),
          /synthetic lost committed reply/,
        );
      f.reconstructRoot();
      await f.client.promote("green-application", "lost-reply", f.claims.pool);
      assert.equal(f.commands.filter((action) => action === "stage").length, 1);
      assert.equal(f.commands.filter((action) => action === "promote").length, 1);
      assert.equal(f.publicProbeReads(), 1);
      assert.equal(f.instances.size, 1);
      assert.equal([...f.instances.values()][0]!.fixture.calls.start, 1);
      assert.equal(
        (await f.client.inspect()).selection!.active.target.applicationId,
        "green-application",
      );
      assert.equal(f.closes(), f.commands.length);
    },
  );

for (const change of ["expiry", "policy"] as const)
  test(
    `a lost accepted public probe reply renews settled evidence after ${change} without starting another candidate`,
    { timeout: 15_000 },
    async (context) => {
      let now = Date.now();
      context.mock.method(Date, "now", () => now);
      const f = await fixture("candidate-probe");
      context.after(() => f.cleanup());
      await assert.rejects(
        f.client.promote("green-application", "renew-evidence", f.claims.pool),
        /synthetic lost committed reply/,
      );
      assert.equal(f.publicProbeReads(), 1);
      assert.deepEqual([...new Set(f.attempts.map((attempt) => attempt.generation))], [0]);
      if (change === "expiry") now += 61_000;
      else {
        const policies =
          await f.old.storage.get<Record<string, { revision: number }>>(nativeMembershipKey);
        assert.ok(policies?.[f.claims.pool]);
        policies[f.claims.pool]!.revision++;
        await f.old.storage.put(nativeMembershipKey, policies);
      }
      f.reconstructRoot();
      const authority = await f.view();
      assert.equal(authority.response.status, 200);
      await f.client.promote("green-application", "renew-evidence", f.claims.pool);
      assert.equal(f.publicProbeReads(), 2);
      assert.equal(f.commands.filter((action) => action === "stage").length, 1);
      assert.equal(f.commands.filter((action) => action === "promote").length, 1);
      assert.deepEqual([...new Set(f.attempts.map((attempt) => attempt.generation))], [0, 1]);
      assert.equal(f.probeKeys.keys.length, 0);
      assert.equal([...f.instances.values()][0]!.fixture.calls.start, 1);
      assert.equal(
        (await f.client.inspect()).selection!.active.target.applicationId,
        "green-application",
      );
    },
  );

for (const action of ["candidate-probe", "promote"] as const)
  test(`an unknown ${action} send without a receipt stays inspection-only after reconstruction`, async (context) => {
    const f = await fixture(`${action}-before`);
    context.after(() => f.cleanup());
    await assert.rejects(
      f.client.promote("green-application", "unknown-send", f.claims.pool),
      /synthetic unknown send before receipt/,
    );
    f.reconstructRoot();
    await assert.rejects(
      f.client.promote("green-application", "unknown-send", f.claims.pool),
      /inspect-only/,
    );
    assert.equal(f.commands.filter((command) => command === action).length, 1);
    assert.deepEqual([...new Set(f.attempts.map((attempt) => attempt.generation))], [0]);
    assert.equal(
      (await f.client.inspect()).selection!.active.identity!.bootId,
      f.old.identity().bootId,
    );
    assert.equal([...f.instances.values()][0]!.fixture.calls.start, 1);
  });

test("a settled refused promotion gets fresh proof and a new durable attempt without another start", async (context) => {
  const f = await fixture("promote-refuse");
  context.after(() => f.cleanup());
  await assert.rejects(
    f.client.promote("green-application", "refused-promotion", f.claims.pool),
    /provisioning-input-drift/,
  );
  const receipt = await f.send("receipt", { operationId: "refused-promotion" });
  assert.equal(
    Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(receipt).status,
    "refused",
  );
  assert.equal(
    (await f.client.inspect()).selection!.active.identity!.bootId,
    f.old.identity().bootId,
  );
  f.reconstructRoot();
  await f.client.promote("green-application", "refused-promotion", f.claims.pool);
  assert.deepEqual([...new Set(f.attempts.map((attempt) => attempt.generation))], [0, 1]);
  assert.equal(f.publicProbeReads(), 2);
  assert.equal(f.commands.filter((command) => command === "promote").length, 2);
  assert.equal(f.commands.filter((command) => command === "stage").length, 1);
  assert.equal([...f.instances.values()][0]!.fixture.calls.start, 1);
  assert.equal(
    (await f.client.inspect()).selection!.active.target.applicationId,
    "green-application",
  );
});

for (const outcome of ["failed", "ready"] as const)
  test(`release recovery respects the terminal ${outcome} startup result after its original deadline`, async (context) => {
    const f = await fixture("public");
    context.after(f.cleanup);
    await assert.rejects(f.client.promote("green-application", "terminal-startup", f.claims.pool));
    const target = f.attempts.at(-1)!.startup.target;
    const key = `runtime-slots-v1:startup:${target.slotId}`;
    const before = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
      await f.old.storage.get(key),
    );
    const deadline = Date.now() - 1000;
    await f.old.storage.put(key, {
      ...before,
      status: outcome,
      deadline,
      ...(outcome === "ready" ? { readyAt: deadline - 1 } : {}),
    });
    assert.ok((await f.client.inspect()).selection?.candidate?.identity);
    f.onPublicProbe((_request, forward) => forward());
    if (outcome === "failed")
      await assert.rejects(
        f.client.promote("green-application", "terminal-startup", f.claims.pool),
        /runtime-startup-failed/,
      );
    else await f.client.promote("green-application", "terminal-startup", f.claims.pool);
    assert.equal(f.commands.filter((action) => action === "stage").length, 1);
    assert.equal(
      f.commands.filter((action) => action === "promote").length,
      outcome === "ready" ? 1 : 0,
    );
    assert.equal([...f.instances.values()][0]!.fixture.calls.start, 1);
  });
