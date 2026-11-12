import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";
import {
  fleetStageState,
  fleetStageRootState,
  fleetStageEndpointState,
} from "../../scripts/scale-test/fleet/state.ts";

test(
  "the actual controller grows named runtimes and drains a planned replacement across held headers, bodies and reconstruction",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture();
    const requests = new Map<string, Promise<Response>>();
    const healthEntered = deferred(),
      healthRelease = deferred();
    let closing = false;
    const pending: {
      id: string;
      instance: string;
      headers: ReturnType<typeof deferred<void>>;
      body?: ReadableStreamDefaultController<Uint8Array>;
    }[] = [];
    const arrivals = new Map<number, ReturnType<typeof deferred<void>>>();
    const waitFor = (count: number) => {
      if (pending.length >= count) return Promise.resolve();
      const event = deferred();
      arrivals.set(count, event);
      return event.promise;
    };
    context.after(async () => {
      closing = true;
      healthRelease.resolve();
      for (const item of pending) {
        item.headers.resolve();
        try {
          item.body?.close();
        } catch {
          /* The source may already have reached its terminal. */
        }
      }
      await Promise.allSettled(requests.values());
      await f.cleanup();
    });
    f.onModel(async (instance, request) => {
      const id = new URL(request.url).searchParams.get("id")!;
      if (id === "green-terminal")
        return new Response(`terminal:${id}`, {
          headers: { "x-fixture-runtime": instance.target.instanceId },
        });
      const item: (typeof pending)[number] = {
        id,
        instance: instance.target.instanceId,
        headers: deferred(),
      };
      pending.push(item);
      arrivals.get(pending.length)?.resolve();
      await item.headers.promise;
      if (closing) return new Response("fixture cleanup");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            item.body = controller;
            controller.enqueue(new TextEncoder().encode(`data:${id}\n`));
          },
        }),
        { headers: { "content-type": "text/event-stream", "x-fixture-runtime": item.instance } },
      );
    });
    const state = new RuntimeFleetState(f.old.storage, 4);
    await f.bootstrap();
    assert.equal(f.old.helper.starts, 1);
    f.providerAvailable(false);
    assert.equal(
      (
        await f.command("fleet-configure", {
          operationId: "provider-refusal",
          configuration: f.configuration,
        })
      ).status,
      409,
    );
    assert.deepEqual(await state.inspect(), []);
    f.providerAvailable(true);
    const enabled = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", { operationId: "enable-1", configuration: f.configuration }),
    );
    assert.equal(f.instances.size, 0);
    assert.equal(f.old.calls.start, 0);
    assert.equal((await f.view()).response.status, 200);

    const dispatch = (id: string) =>
      requests.set(id, f.model(new Request(`https://pool.invalid/v1/models?id=${id}`)));
    for (let index = 0; index < 4; index++) dispatch(`old-${index}`);
    await waitFor(4);
    const ready = f.resourcesWhen(
      (rows) => rows.length === 2 && rows.every((row) => row.phase === "ready"),
    );
    now += 101;
    await f.upkeep();
    const blue = await ready;
    assert.equal(blue.length, 2);
    assert.ok(
      blue.every((row) => row.phase === "ready" && row.target.applicationId === "blue-application"),
    );
    assert.equal(new Set(blue.map((row) => row.target.instanceId)).size, 2);
    assert.equal(new Set(blue.map((row) => row.target.homePeerOrdinal)).size, 2);
    for (const instance of f.instances.values()) {
      assert.equal(instance.fixture.calls.start, 1);
      assert.equal(instance.fixture.calls.interceptions.length, 1);
    }
    const updated = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "enable-2",
        configuration: {
          ...f.configuration,
          revision: 2,
          previousDigest: enabled.digest,
          targetActive: 100,
        },
      }),
    );
    for (let index = 0; index < 2; index++) dispatch(`blue-${index}`);
    await waitFor(6);
    const held = await state.inspect();
    assert.ok(held.every((row) => row.active === 1));
    assert.equal(new Set(pending.map((item) => item.instance)).size, 3);
    const previous = held[0]!.identity!;
    const previousInstance = f.instances.get(previous.instanceId)!;
    const previousRequest = pending.find((item) => item.instance === previous.instanceId)!;

    await f.send("fleet-configure", {
      operationId: "enable-green",
      configuration: {
        ...f.configuration,
        revision: 3,
        previousDigest: updated.digest,
        targetActive: 100,
        active: "green",
      },
    });
    f.onRuntimeCreated(async (instance, color) => {
      if (color === "green")
        instance.hooks.health = async () => {
          healthEntered.resolve();
          await healthRelease.promise;
        };
    });
    const originalFetch = previousInstance.worker.fetch.bind(previousInstance.worker);
    let refusedDrain = false;
    previousInstance.worker.fetch = async (request) => {
      if (new URL(request.url).pathname === "/drain" && !refusedDrain) {
        refusedDrain = true;
        throw new Error("synthetic drain not dispatched");
      }
      return originalFetch(request);
    };
    await f.send("fleet-replace", { operationId: "replace-1", identity: previous });
    now += 1_001;
    const replacement = f.upkeep();
    await healthEntered.promise;
    assert.equal(
      (await state.inspect()).find((row) => row.target.instanceId === previous.instanceId)!.phase,
      "ready",
    );
    assert.equal(previousInstance.fixture.calls.destroy, 0);
    healthRelease.resolve();
    await replacement;
    assert.equal(refusedDrain, true);
    const unacknowledged = (await state.inspect()).find(
      (row) => row.target.instanceId === previous.instanceId,
    )!;
    assert.equal(unacknowledged.phase, "draining");
    assert.equal(unacknowledged.active, 1);
    assert.notEqual(unacknowledged.drainAcknowledged, true);
    assert.ok((await f.old.storage.getAlarm())! <= now + 2000);
    await f.upkeep();
    assert.equal(
      (await state.inspect()).find((row) => row.target.instanceId === previous.instanceId)!
        .drainAcknowledged,
      true,
    );
    assert.equal(
      (await state.inspect()).find((row) => row.target.instanceId === previous.instanceId)!.phase,
      "draining",
    );
    assert.equal(previousInstance.fixture.calls.destroy, 0);
    const endpointActivity = await previousInstance.fixture.storage.get<{
      phase: string;
      active: number;
      known: boolean;
    }>(`runtime-activity-v1:${JSON.stringify([previous.slotId, previous.bootId])}`);
    assert.equal(endpointActivity?.phase, "draining");
    assert.equal(endpointActivity?.active, 1);
    assert.equal(endpointActivity?.known, true);
    const rootCommits = f.old.storage.afterCommit;
    const endpointCommits = previousInstance.fixture.storage.afterCommit;
    let snapshotWrites = 0;
    f.old.storage.afterCommit = (keys) => {
      snapshotWrites += keys.length;
      rootCommits?.(keys);
    };
    previousInstance.fixture.storage.afterCommit = (keys) => {
      snapshotWrites += keys.length;
      endpointCommits?.(keys);
    };
    try {
      const root = await fleetStageRootState(previous, f.old.storage);
      const endpoint = await fleetStageEndpointState(previous, previousInstance.fixture.storage);
      assert.equal(root?.phase, "draining");
      assert.equal(root?.active, 1);
      assert.equal(endpoint?.activity?.phase, "draining");
      assert.equal(endpoint?.activity?.active, 1);
      assert.equal(endpoint?.identity?.bootId, previous.bootId);
      assert.deepEqual(
        await fleetStageState(previous, {
          root: f.old.storage,
          endpoint: previousInstance.fixture.storage,
        }),
        { root, endpoint },
      );
      await assert.rejects(
        fleetStageEndpointState(
          { ...previous, applicationId: "foreign" },
          previousInstance.fixture.storage,
        ),
        /target drift/,
      );
      assert.equal(snapshotWrites, 0);
    } finally {
      f.old.storage.afterCommit = rootCommits;
      previousInstance.fixture.storage.afterCommit = endpointCommits;
    }
    const rejected = await previousInstance.worker.fetch(
      new Request("https://pool.invalid/v1/models?should-not-dispatch", {
        headers: {
          "X-Signalbox-Runtime-Identity": JSON.stringify(previous),
          "X-Signalbox-Runtime-Port": "8317",
        },
      }),
    );
    assert.equal(rejected.status, 409);
    assert.equal(pending.length, 6);
    const greenResponse = await f.model(
      new Request("https://pool.invalid/v1/models?id=green-terminal"),
    );
    assert.equal(await greenResponse.text(), "terminal:green-terminal");
    const greenInstance = f.instances.get(greenResponse.headers.get("x-fixture-runtime")!)!;
    assert.equal(greenInstance.color, "green");
    assert.equal(previousInstance.fixture.calls.destroy, 0);
    f.reconstruct();
    assert.equal(
      (await state.inspect()).find((row) => row.target.instanceId === previous.instanceId)!.active,
      1,
    );
    assert.equal(f.old.helper.starts, 1);
    assert.equal(previousInstance.fixture.calls.start, 1);

    previousRequest.headers.resolve();
    const previousResponse = await requests.get(previousRequest.id)!;
    const previousBody = previousResponse.text();
    now += 1_001;
    await f.upkeep();
    assert.equal(previousInstance.fixture.calls.destroy, 0);
    previousRequest.body!.enqueue(new TextEncoder().encode(`terminal:${previousRequest.id}`));
    previousRequest.body!.close();
    assert.equal(await previousBody, `data:${previousRequest.id}\nterminal:${previousRequest.id}`);
    await previousInstance.fixture.settle();
    await f.resourcesWhen(
      (rows) => rows.find((row) => row.target.instanceId === previous.instanceId)?.active === 0,
    );
    now += 1_001;
    await f.upkeep();
    assert.equal(previousInstance.fixture.calls.destroy, 1);
    assert.equal(
      (await state.inspect()).some((row) => row.target.instanceId === previous.instanceId),
      false,
    );
    const receipt = Schema.decodeUnknownSync(
      Schema.Struct({ replacement: Schema.Struct({ status: Schema.Literal("retired") }) }),
    )(await f.send("fleet-inspect", { operationId: "replace-1" }));
    assert.equal(receipt.replacement.status, "retired");

    const permission = Schema.decodeUnknownSync(
      Schema.Struct({ permission: Schema.Struct({ digest: Schema.String }) }),
    )(await f.send("fleet-inspect"));
    await f.send("fleet-disable", {
      operationId: "disable-fleet",
      expectedDigest: permission.permission.digest,
    });
    const primaryAfterDisable = await f.model(
      new Request("https://pool.invalid/v1/models?id=green-terminal"),
    );
    assert.equal(await primaryAfterDisable.text(), "terminal:green-terminal");
    assert.equal(primaryAfterDisable.headers.get("x-fixture-runtime"), f.old.target.instanceId);
    await f.upkeep();
    const remainingHeld = (await state.inspect()).find((row) => row.active === 1)!;
    assert.equal(remainingHeld.phase, "draining");
    const remaining = f.instances.get(remainingHeld.target.instanceId)!;
    assert.equal(
      (
        await new (
          await import("./runtime-slots/activity.ts")
        ).RuntimeActivity(remaining.fixture.storage).inspect(remainingHeld.identity!)
      )?.phase,
      "draining",
    );

    for (const item of pending) {
      if (item === previousRequest) continue;
      item.headers.resolve();
      const response = await requests.get(item.id)!;
      const body = response.text();
      item.body!.enqueue(new TextEncoder().encode(`terminal:${item.id}`));
      item.body!.close();
      assert.equal(await body, `data:${item.id}\nterminal:${item.id}`);
    }
    await f.settle();
    assert.ok((await state.inspect()).every((row) => row.active === 0));
    assert.equal(
      f.old.calls.model +
        [...f.instances.values()].reduce((sum, instance) => sum + instance.fixture.calls.model, 0),
      8,
    );
    assert.equal(f.old.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
  },
);

test("the actual controller refuses an absent named secret and observes it without reconstruction", async (context) => {
  const f = await fleetWorkerFixture();
  context.after(f.cleanup);
  await f.bootstrap();
  f.secretAvailable(false);
  const before = f.providerReads.length;
  const fields = { operationId: "secret-recovery", configuration: f.configuration };
  assert.equal((await f.command("fleet-configure", fields)).status, 409);
  assert.equal(f.providerReads.length, before);
  assert.deepEqual(await new RuntimeFleetState(f.old.storage, 4).inspect(), []);
  assert.equal(f.instances.size, 0);
  f.secretAvailable(true);
  assert.equal((await f.command("fleet-configure", fields)).status, 200);
  assert.ok(f.providerReads.length > before);
  assert.equal(f.instances.size, 0);
});
