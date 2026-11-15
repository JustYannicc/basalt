import assert from "node:assert/strict";
import { test } from "node:test";
import { historyBackend } from "./history-backend.mjs";

test(
  "cancellation observed before release keeps the held response aborted",
  { timeout: 2_000 },
  async (t) => {
    const fixture = await historyBackend();
    t.after(() => fixture.close());
    fixture.hold("bounded");
    const controller = new AbortController();
    const response = fetch(`${fixture.origin}/_executor/api/query`, {
      method: "POST",
      body: JSON.stringify({
        name: "publicHistory",
        input: { from: "2026-11-04", to: "2026-11-05" },
      }),
      signal: controller.signal,
    });
    const canceled = assert.rejects(response, { name: "AbortError" });
    await fixture.waitFor(() => fixture.requests.length === 1, { name: "held bounded response" });
    const [pending] = fixture.requests;
    controller.abort();
    await canceled;
    await fixture.waitFor(() => pending.aborted, { name: "bounded response cancellation" });
    fixture.release();
    assert.equal(pending.aborted, true);
    assert.equal(pending.response.writableEnded, false);
    assert.equal(pending.response.destroyed, true);
  },
);

test("closing history rejects an outstanding named wait", { timeout: 2_000 }, async (t) => {
  const fixture = await historyBackend();
  t.after(() => fixture.close());
  const rejected = assert.rejects(
    fixture.waitFor(() => false, { name: "missing series request" }),
    /History fixture closed while waiting for missing series request/,
  );
  await fixture.close();
  await rejected;
});

test(
  "release before cancellation fails its abort wait promptly with the pending phase",
  { timeout: 2_000 },
  async (t) => {
    const fixture = await historyBackend();
    t.after(() => fixture.close());
    fixture.hold("bounded");
    const controller = new AbortController();
    const response = fetch(`${fixture.origin}/_executor/api/query`, {
      method: "POST",
      body: JSON.stringify({
        name: "publicHistory",
        input: { from: "2026-11-04", to: "2026-11-05" },
      }),
      signal: controller.signal,
    });
    await fixture.waitFor(() => fixture.requests.length === 1, { name: "held bounded response" });
    const [pending] = fixture.requests;
    fixture.release();
    await (await response).text();
    controller.abort();
    assert.equal(pending.response.writableEnded, true);
    assert.equal(pending.aborted, false);
    await assert.rejects(
      fixture.waitFor(() => pending.aborted, {
        name: "bounded response cancellation",
        timeout: 50,
      }),
      /Timed out waiting for bounded response cancellation.*phase=bounded.*aborted=false.*ended=true/,
    );
  },
);
