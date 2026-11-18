import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { runAcceptance } from "./acceptance.ts";

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
