import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardRecoverably } from "./runtime-fleet/retry.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import { FleetRefused } from "./runtime-fleet/state.ts";
import { deferred } from "../../scripts/pool-tests/runtime-slot-storage.ts";

test("a healthy accepted model request retains its caller deadline while waiting for headers", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const entered = deferred(),
    headers = deferred();
  let finished = false;
  const response = forwardRecoverably(
    new Request("http://pool/v1/responses", { method: "POST", body: "payload" }),
    async (_request, dispatch) => {
      dispatch();
      entered.resolve();
      await headers.promise;
      return new Response("healthy");
    },
    () => {},
  ).then((value) => {
    finished = true;
    return value;
  });
  await entered.promise;
  context.mock.timers.tick(201_000);
  await Promise.resolve();
  assert.equal(finished, false);
  headers.resolve();
  assert.equal(await (await response).text(), "healthy");
});

test("a successful dispatched upload keeps transport ownership after headers", async () => {
  let accepted!: Request;
  const response = await forwardRecoverably(
    new Request("http://pool/v1/responses", { method: "POST", body: "upload" }),
    async (request, dispatch) => {
      accepted = request;
      dispatch();
      return new Response("headers");
    },
    () => {},
  );
  assert.equal(response.status, 200);
  assert.equal(await accepted.text(), "upload");
});

test("an undispatched retry closes its failed upload branch and preserves the next upload", async () => {
  let calls = 0,
    first!: Request;
  const response = await forwardRecoverably(
    new Request("http://pool/v1/responses", { method: "POST", body: "upload" }),
    async (request, dispatch) => {
      if (++calls === 1) {
        first = request;
        throw new SlotRefused("unhealthy");
      }
      dispatch();
      return new Response(await request.text());
    },
    () => {},
  );
  assert.equal(await response.text(), "upload");
  assert.equal((await first.body!.getReader().read()).done, true);
});

test("capacity refusal closes both retained upload branches", async () => {
  const cancelled = deferred();
  const body = new ReadableStream({
    cancel() {
      cancelled.resolve();
    },
  });
  const init = { method: "POST", body, duplex: "half" };
  const response = await forwardRecoverably(
    new Request("http://pool/v1/responses", init),
    async () => {
      throw new FleetRefused("capacity");
    },
    () => {},
  );
  assert.equal(response.status, 503);
  await cancelled.promise;
});
