import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { awaitRecoveryReady, healingOutcome, runAcceptance, servingBoot } from "./acceptance.ts";
import { stopPaths } from "./stop-path.ts";

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
  assert.deepEqual(healed, { ready: true, boot: "boot-new", waitedMs: 15_000, reads: 4 });
});

test("a new boot whose recovery needs a person ends the wait at once, naming the reason", async () => {
  const controller = replies(inspected("boot-new", { needsPerson: "restart_failed" }));
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 300_000,
    ...clock(),
  });
  assert.equal(controller.reads(), 1);
  assert.deepEqual(
    { ready: verdict.ready, boot: verdict.boot, reason: !verdict.ready && verdict.reason },
    { ready: false, boot: "boot-new", reason: "needs a person (restart_failed)" },
  );
});

test("a person needed on the stuck boot does not end the wait: it can be what the release heals", async () => {
  const controller = replies(
    inspected("boot-stuck", { needsPerson: "restart_failed" }),
    inspected("boot-stuck", { needsPerson: "restart_failed" }),
    inspected("boot-new"),
  );
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 300_000,
    ...clock(),
  });
  assert.deepEqual(verdict, { ready: true, boot: "boot-new", waitedMs: 10_000, reads: 3 });
});

test("the stuck boot is never ready, and the wait is bounded", async () => {
  const controller = replies(inspected("boot-stuck"));
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 60_000,
    ...clock(),
  });
  assert.equal(controller.reads(), 13);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.boot, undefined);
  assert.match(!verdict.ready ? verdict.reason : "", /not ready within 60 s/u);
});

test("while the stop waits for in-flight streams the wait says so, and a timeout names the last read", async () => {
  const controller = replies(inspected("boot-stuck", { activeStreams: 3, streamsWaitingSince: 1 }));
  const verdict = await awaitRecoveryReady({
    inspect: controller.inspect,
    before: "boot-stuck",
    withinMs: 20_000,
    ...clock(),
  });
  assert.ok(!verdict.ready);
  assert.match(verdict.last, /in-flight streams to stand still/u);
  assert.match(verdict.last, /recovery fields: activeStreams, streamsWaitingSince/u);
});

test("a healing release ends healed, serving but needing a person, or not serving", () => {
  const ready = { ready: true as const, boot: "boot-new", waitedMs: 1, reads: 1 };
  const unfinished = (boot?: string) => ({
    ready: false as const,
    ...(boot ? { boot } : {}),
    reason: "needs a person (restart_failed)",
    last: "a new boot, recovery not ready",
    waitedMs: 1,
    reads: 1,
  });
  const served = { passed: true };
  const refused = { passed: false };
  assert.equal(healingOutcome(ready, served), "healed");
  assert.equal(healingOutcome(unfinished("boot-new"), served), "serving-needs-person");
  // Anything else is not serving: a failed model call, or no new boot.
  assert.equal(healingOutcome(ready, refused), "not-serving");
  assert.equal(healingOutcome(unfinished("boot-new"), refused), "not-serving");
  assert.equal(healingOutcome(unfinished(), served), "not-serving");
  assert.equal(healingOutcome(unfinished(), undefined), "not-serving");
});

test("the stop path is read from the forced-stop lines only, as fixed words", () => {
  const answer = JSON.stringify({
    result: {
      events: [
        { message: 'POOL_RUNTIME_FORCED_STOP {"path":"graceful_exit","boot":"boot-stuck"}' },
        { message: 'POOL_RUNTIME_FORCED_STOP {"path":"https://host.example/x"}' },
        { message: 'OTHER_LINE {"path":"destroy_after_grace"}' },
      ],
    },
  });
  assert.deepEqual(stopPaths(answer), ["graceful_exit", "unreadable"]);
});
