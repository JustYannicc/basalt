import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { runtimeApplicationFixture } from "../../scripts/pool-tests/runtime-provider-fixture.ts";

async function promoted() {
  const f = await handoffWorker();
  const grant = await f.startGrant();
  const staged = await f.stage(grant.envelope);
  assert.equal(staged.status, 200, await staged.clone().text());
  const joined = await f.joined(grant);
  const response = await f.command("promote", { intent: await f.intent(), proof: joined.envelope });
  assert.equal(response.status, 200, await response.clone().text());
  return f;
}

for (const fault of ["before", "after"] as const) {
  test(`primary retirement recovers ${fault} dispatch after reconstruction and destroys once`, async (context) => {
    const f = await promoted();
    context.after(f.cleanup);
    const operationId = `primary-retire-${fault}`;
    let injected = 0;
    if (fault === "before") {
      f.old.storage.afterCommit = (keys) => {
        if (!injected && keys.includes(`runtime-slots-v1:retirement:${operationId}`)) {
          injected++;
          throw new Error("synthetic lost Root retirement commit acknowledgement");
        }
      };
    } else {
      const destroy = f.old.ctx.container.destroy.bind(f.old.ctx.container);
      context.mock.method(f.old.ctx.container, "destroy", async () => {
        await destroy();
        if (!injected++) throw new Error("synthetic lost endpoint destroy acknowledgement");
      });
    }
    assert.equal((await f.command("drain", { operationId })).status, 409);
    assert.equal(injected, 1);
    assert.equal(f.old.calls.destroy, fault === "before" ? 0 : 1);
    assert.ok((await f.inspect()).selection.draining);
    f.old.storage.afterCommit = () => {};
    f.reconstruct();
    const result = await f.command("drain", { operationId });
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal((await f.inspect()).selection.draining, undefined);
    assert.equal(f.old.calls.destroy, 1);
    assert.equal((await f.command("drain", { operationId })).status, 200);
    assert.equal((await f.model()).status, 200);
  });
}

test("native retirement retains primary capacity until current provider absence is positive", async (context) => {
  const f = await promoted();
  context.after(f.cleanup);
  const fetcher = globalThis.fetch;
  const raw = runtimeApplicationFixture(f.old.target);
  let retained = true;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (retained && url.pathname.endsWith(`/applications/${raw.id}/instances-v2`))
      return Response.json({
        success: true,
        errors: [],
        result: [
          {
            id: f.old.target.instanceId,
            application_id: raw.id,
            status: { state: "running" },
            image: raw.configuration.image,
          },
        ],
        result_info: { next_page_token: "" },
      });
    return fetcher(input, init);
  };
  const operationId = "provider-absence-delayed";
  assert.equal((await f.command("drain", { operationId })).status, 409);
  assert.equal(f.old.calls.destroy, 1);
  assert.equal(f.old.ctx.container.running, false);
  assert.ok((await f.inspect()).selection.draining);
  f.reconstruct();
  assert.equal((await f.command("drain", { operationId })).status, 409);
  assert.equal(f.old.calls.destroy, 1);
  retained = false;
  assert.equal((await f.command("drain", { operationId })).status, 200);
  assert.equal((await f.inspect()).selection.draining, undefined);
  assert.equal(f.old.calls.destroy, 1);
});
