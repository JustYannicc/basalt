import assert from "node:assert/strict";
import { test } from "node:test";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

test(
  "the actual controller quarantines a crashed cell, preserves surviving streams and replaces only absent compute",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const f = await fleetWorkerFixture(),
      rootEntered = deferred(),
      rootRelease = deferred();
    const bodies = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const attempts = new Map<string, number>();
    const rootCalls: Promise<Response>[] = [];
    let rootCount = 0;
    context.after(async () => {
      rootRelease.resolve();
      for (const body of bodies.values()) {
        try {
          body.close();
        } catch {}
      }
      await Promise.allSettled(rootCalls);
      await f.cleanup();
    });
    f.onModel(async (instance, request) => {
      const id = new URL(request.url).searchParams.get("id")!;
      attempts.set(id, (attempts.get(id) ?? 0) + 1);
      const headers = { "x-fixture-runtime": instance.target.instanceId };
      if (id.startsWith("root-held")) {
        if (++rootCount === 4) rootEntered.resolve();
        await rootRelease.promise;
        return new Response(`terminal:${id}`, { headers });
      }
      if (id.startsWith("cell-held"))
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              bodies.set(instance.target.instanceId, controller);
              controller.enqueue(new TextEncoder().encode(`prefix:${id}\n`));
            },
          }),
          { headers },
        );
      return new Response(`terminal:${id}`, { headers });
    });
    await f.bootstrap();
    await f.send("fleet-configure", {
      operationId: "failure-proof",
      configuration: f.configuration,
    });
    for (let index = 0; index < 4; index++)
      rootCalls.push(f.model(new Request(`http://pool/v1/models?id=root-held-${index}`)));
    await rootEntered.promise;
    now += 101;
    await f.upkeep();
    const initial = await f.resourcesWhen(
      (rows) => rows.length === 2 && rows.every((row) => row.phase === "ready"),
    );
    const first = await f.model(new Request("http://pool/v1/models?id=cell-held-0"));
    const second = await f.model(new Request("http://pool/v1/models?id=cell-held-1"));
    const deadId = first.headers.get("x-fixture-runtime")!,
      siblingId = second.headers.get("x-fixture-runtime")!;
    assert.notEqual(deadId, siblingId);
    const reader = first.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /prefix:cell-held-0/);
    const interrupted = reader.read();
    f.instances.get(deadId)!.fixture.crash();
    bodies.get(deadId)!.error(new Error("synthetic SIGKILL transport"));
    await assert.rejects(interrupted, /SIGKILL transport/);
    const state = new RuntimeFleetState(f.old.storage, 4);
    await f.resourcesWhen(
      (rows) => rows.find((row) => row.target.instanceId === deadId)?.phase === "quarantined",
    );
    f.reconstruct();
    for (let index = 0; index < 11; index++) {
      const response = await f.model(new Request(`http://pool/v1/models?id=fresh-${index}`));
      assert.equal(response.status, 200);
      assert.notEqual(response.headers.get("x-fixture-runtime"), deadId);
      assert.equal(await response.text(), `terminal:fresh-${index}`);
    }
    assert.equal(attempts.get("cell-held-0"), 1);
    bodies.get(siblingId)!.enqueue(new TextEncoder().encode("terminal:cell-held-1"));
    bodies.get(siblingId)!.close();
    assert.equal(await second.text(), "prefix:cell-held-1\nterminal:cell-held-1");
    rootRelease.resolve();
    for (let index = 0; index < rootCalls.length; index++)
      assert.equal(await (await rootCalls[index]!).text(), `terminal:root-held-${index}`);
    await f.settle();
    now += 101;
    await f.upkeep();
    await f.settle();
    const replaced = await state.inspect();
    assert.ok(replaced.every((row) => row.target.instanceId !== deadId));
    assert.ok(
      replaced.some(
        (row) => !initial.some((previous) => previous.target.instanceId === row.target.instanceId),
      ),
    );
    assert.ok(replaced.length <= f.configuration.maximum);
    const dead = f.instances.get(deadId)!.fixture;
    assert.equal(dead.calls.start, 1);
    assert.equal(dead.calls.destroy, 0);
    assert.equal(attempts.get("cell-held-0"), 1);
  },
);
