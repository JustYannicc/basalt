import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { awaitRecoveryReady, RootRestartFailed, runAcceptance, servingBoot } from "./acceptance.ts";

// A pool endpoint speaking the real wire: /v1/models JSON and a streamed chat completion, each with
// the serving runtime's boot header, as the live pool answers the repo's acceptance client.
async function pool(options: { fail?: number; boots?: string[] } = {}) {
  let chats = 0;
  const server = createServer((request, response) => {
    const boot = options.boots?.[chats % options.boots.length] ?? "boot-root";
    if (request.url === "/v1/models") {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-signalbox-pool-boot": "boot-root",
      });
      response.end(JSON.stringify({ object: "list", data: [{ id: "model-a", object: "model" }] }));
      return;
    }
    chats++;
    if (options.fail !== undefined && chats === options.fail) {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "busy" }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "x-signalbox-pool-boot": boot });
    response.end('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    client: new PoolAcceptanceClient({ origin: `http://127.0.0.1:${port}` }),
    chats: () => chats,
    close: () => server.close(),
  };
}

test("27 streamed requests on one unchanged root pass a code-only release", async () => {
  const live = await pool();
  try {
    const result = await runAcceptance({ apiKey: "k", expect: "same-boot", client: live.client });
    assert.equal(result.passed, true, result.cause ?? "");
    assert.equal(live.chats(), 27);
    assert.deepEqual(result.boots, ["boot-root"]);
  } finally {
    live.close();
  }
});

test("one failed request in the burst fails the release and names it", async () => {
  const live = await pool({ fail: 9 });
  try {
    const result = await runAcceptance({ apiKey: "k", expect: "same-boot", client: live.client });
    assert.equal(result.passed, false);
    assert.match(result.cause ?? "", /1 of 27 requests failed: .*503/u);
  } finally {
    live.close();
  }
});

test("a root that changed boot fails a code-only release", async () => {
  const live = await pool({ boots: ["boot-root", "boot-new"] });
  try {
    const result = await runAcceptance({ apiKey: "k", expect: "same-boot", client: live.client });
    assert.match(result.cause ?? "", /changed boot/u);
  } finally {
    live.close();
  }
});

test("the fleet passes only when a second runtime served", async () => {
  const root = await pool();
  try {
    const result = await runAcceptance({
      apiKey: "k",
      expect: "two-runtimes",
      client: root.client,
    });
    assert.match(result.cause ?? "", /no fleet cell served/u);
  } finally {
    root.close();
  }
  const fleet = await pool({ boots: ["boot-root", "boot-cell-1"] });
  try {
    assert.equal(
      (await runAcceptance({ apiKey: "k", expect: "two-runtimes", client: fleet.client })).passed,
      true,
    );
  } finally {
    fleet.close();
  }
});

test("a root that restarted during the apply fails acceptance, so the release rolls back", async () => {
  const live = await pool({ boots: ["boot-root-new"] });
  try {
    const before = "boot-root";
    const result = await runAcceptance({
      apiKey: "k",
      expect: "same-boot",
      rootBoot: before,
      client: live.client,
    });
    assert.equal(result.passed, false);
    assert.match(result.cause ?? "", /The root restarted: boot boot-root before the apply/u);
  } finally {
    live.close();
  }
});

test("the root's boot read before the apply passes when the root kept it", async () => {
  const live = await pool();
  try {
    const before = await servingBoot("k", live.client);
    assert.equal(before, "boot-root");
    const result = await runAcceptance({
      apiKey: "k",
      expect: "same-boot",
      rootBoot: before,
      client: live.client,
    });
    assert.equal(result.passed, true, result.cause ?? "");
  } finally {
    live.close();
  }
});

test("with fleet cells serving, the root's boot must still be among the runtimes", async () => {
  const live = await pool({ boots: ["boot-cell-1", "boot-cell-2"] });
  try {
    const result = await runAcceptance({
      apiKey: "k",
      expect: "any",
      rootBoot: "boot-root-gone",
      client: live.client,
    });
    assert.equal(result.passed, false);
    assert.match(result.cause ?? "", /The root restarted/u);
  } finally {
    live.close();
  }
});

// A clock the wait advances itself, so the bound is exercised without waiting it out.
const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (milliseconds: number) => void (at += milliseconds) };
};
/** `inspect` replies in turn: an Error is a refusal, anything else the reply's result. */
const replies = (...script: unknown[]) => {
  let reads = 0;
  return {
    reads: () => reads,
    inspect: async () => {
      const next = script[Math.min(reads++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
};
const inspected = (bootId: string, recovery: Record<string, unknown> = {}) => ({
  selection: { active: { identity: { bootId } } },
  recovery,
});

test("a healing release waits for recovery ready: a new boot, no restart pending, no person needed", async () => {
  const controller = replies(
    // The new controller refuses on identity until it has adopted its code.
    Object.assign(new Error("inspect refused by the controller"), { reason: "identity" }),
    inspected("boot-stuck"),
    // The forced stop sets restartedAt; recovery clears it at ready.
    inspected("boot-new", { restartedAt: 1_700_000_000_000 }),
    inspected("boot-new"),
  );
  const healed = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 300_000,
    ...clock(),
  });
  assert.deepEqual(healed, { boot: "boot-new", waitedMs: 15_000, reads: 4 });
});

test("a recovery that needs a person fails at once with that reason, without waiting out the bound", async () => {
  const controller = replies(inspected("boot-stuck", { needsPerson: "provider-observation" }));
  await assert.rejects(
    awaitRecoveryReady({
      inspect: controller.inspect,
      before: "boot-stuck",
      withinMs: 300_000,
      ...clock(),
    }),
    (error: unknown) =>
      error instanceof RootRestartFailed &&
      /needs a person \(provider-observation\)/u.test(error.why) &&
      controller.reads() === 1,
  );
});

test("the stuck boot is never ready, and the wait is bounded", async () => {
  const controller = replies(inspected("boot-stuck"));
  await assert.rejects(
    awaitRecoveryReady({
      inspect: controller.inspect,
      before: "boot-stuck",
      withinMs: 60_000,
      ...clock(),
    }),
    (error: unknown) =>
      error instanceof RootRestartFailed &&
      /within 60 s/u.test(error.why) &&
      controller.reads() === 13,
  );
});
