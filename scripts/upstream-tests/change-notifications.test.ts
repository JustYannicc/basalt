import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { build } from "esbuild";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { Miniflare } = require("miniflare") as typeof import("miniflare");
const source = `
import { DurableObject } from 'cloudflare:workers';
import { Effect } from 'effect';
import { makeChangeNotifications } from './packages/app-data/src/implementation/change-notifications.ts';
const keys = [{topic:'deployment',resource:'app-a'}];
export class Owner extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.state=ctx; this.changes=makeChangeNotifications(ctx); }
  async fetch(request) {
    const pair=new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    await Effect.runPromise(this.changes.initial(pair[1],keys));
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  publish(hint) { return Effect.runPromise(this.changes.publish(hint)); }
  webSocketMessage(ws) { return Effect.runPromise(this.changes.initial(ws,keys)); }
}
export default {fetch(request, env) {
  return env.OWNER.getByName('organization:team-a').fetch(request);
}};`;
const writer = `export default {async fetch(request, env) {
  await env.OWNER.getByName('organization:team-a').publish(await request.json());
  return new Response(null,{status:204});
}};`;
const entry = `export default {fetch(request, env) {
  return new URL(request.url).pathname==='/publish' ? env.WRITER.fetch(request) : env.SUBSCRIBER.fetch(request);
}};`;
async function runtime() {
  const code = await build({
    stdin: {
      contents: source,
      resolveDir: new URL("../../.upstream", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    target: "es2023",
    external: ["cloudflare:workers"],
  });
  return new Miniflare({
    workers: [
      {
        name: "entry",
        modules: true,
        script: entry,
        compatibilityDate: "2026-08-06",
        serviceBindings: { WRITER: "writer", SUBSCRIBER: "subscriber" },
      },
      {
        name: "writer",
        modules: true,
        script: writer,
        compatibilityDate: "2026-08-06",
        durableObjects: { OWNER: { className: "Owner", scriptName: "subscriber" } },
      },
      {
        name: "subscriber",
        modules: true,
        script: code.outputFiles[0]!.text,
        compatibilityDate: "2026-08-06",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: { OWNER: { className: "Owner", useSQLite: true } },
      },
    ],
  });
}
async function connect(mf: Awaited<ReturnType<typeof runtime>>) {
  const response = await mf.dispatchFetch("https://fixture/subscribe", {
    headers: { Upgrade: "websocket" },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket!;
  const messages: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  socket.addEventListener("message", (event) => {
    const value: unknown = JSON.parse(String(event.data));
    const next = waiting.shift();
    if (next) next(value);
    else messages.push(value);
  });
  socket.accept();
  return {
    socket,
    next: () =>
      messages.length
        ? Promise.resolve(messages.shift())
        : new Promise<unknown>((resolve) => waiting.push(resolve)),
  };
}
const hint = { topic: "deployment", resource: "app-a", revision: "1" };

test("a writer in another Worker isolate reaches a registered subscriber", async () => {
  const mf = await runtime();
  try {
    const subscriber = await connect(mf);
    assert.deepEqual(await subscriber.next(), {
      kind: "current",
      revisions: [{ ...hint, revision: "0" }],
      snapshotRequired: true,
    });
    assert.equal(
      (
        await mf.dispatchFetch("https://fixture/publish", {
          method: "POST",
          body: JSON.stringify(hint),
        })
      ).status,
      204,
    );
    // The following current reply fences the publication without relying on a timeout or sleep.
    subscriber.socket.send("current");
    assert.deepEqual(await subscriber.next(), { kind: "changed", hint });
    assert.deepEqual(await subscriber.next(), {
      kind: "current",
      revisions: [hint],
      snapshotRequired: true,
    });
    subscriber.socket.close();
  } finally {
    await mf.dispose();
  }
});

test("disconnect and reconnect obtains the current durable revision", async () => {
  const mf = await runtime();
  try {
    const first = await connect(mf);
    await first.next();
    first.socket.close();
    assert.equal(
      (
        await mf.dispatchFetch("https://fixture/publish", {
          method: "POST",
          body: JSON.stringify(hint),
        })
      ).status,
      204,
    );
    const resumed = await connect(mf);
    assert.deepEqual(await resumed.next(), {
      kind: "current",
      revisions: [hint],
      snapshotRequired: true,
    });
    resumed.socket.close();
  } finally {
    await mf.dispose();
  }
});
