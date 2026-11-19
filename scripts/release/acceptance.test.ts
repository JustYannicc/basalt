import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import {
  awaitRootRestart,
  NOT_SERVING,
  RootRestartFailed,
  runAcceptance,
  servingBoot,
} from "./acceptance.ts";

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

/** A pool whose /v1/models answers in turn from a script: a status and, when serving, a boot. */
async function healingPool(script: ReadonlyArray<{ status: number; boot?: string }>) {
  let reads = 0;
  const server = createServer((request, response) => {
    const step = script[Math.min(reads++, script.length - 1)]!;
    response.writeHead(step.status, {
      "content-type": "application/json",
      ...(step.boot ? { "x-signalbox-pool-boot": step.boot } : {}),
    });
    response.end(
      step.status === 200
        ? JSON.stringify({ object: "list", data: [{ id: "model-a", object: "model" }] })
        : JSON.stringify({ error: "refusing" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    client: new PoolAcceptanceClient({ origin: `http://127.0.0.1:${port}` }),
    reads: () => reads,
    close: () => server.close(),
  };
}
// A clock the wait advances itself, so the bound is exercised without waiting it out.
const clock = () => {
  let at = 0;
  return { now: () => at, sleep: async (milliseconds: number) => void (at += milliseconds) };
};

test("a declared root restart waits for a new boot read twice, from a pool that was not serving", async () => {
  const live = await healingPool([
    { status: 503 },
    { status: 503 },
    { status: 200, boot: "boot-new" },
    { status: 200, boot: "boot-new" },
  ]);
  try {
    const healed = await awaitRootRestart({
      apiKey: "key",
      before: NOT_SERVING,
      withinMs: 420_000,
      client: live.client,
      ...clock(),
    });
    assert.deepEqual(healed, { boot: "boot-new", waitedMs: 30_000, reads: 4 });
  } finally {
    live.close();
  }
});

test("the boot from before the apply is not a restart, and the wait is bounded", async () => {
  const live = await healingPool([{ status: 200, boot: "boot-old" }]);
  try {
    await assert.rejects(
      awaitRootRestart({
        apiKey: "key",
        before: "boot-old",
        withinMs: 60_000,
        client: live.client,
        ...clock(),
      }),
      (error: unknown) =>
        error instanceof RootRestartFailed && /within 60 s/u.test(error.why) && live.reads() === 7,
    );
  } finally {
    live.close();
  }
});
