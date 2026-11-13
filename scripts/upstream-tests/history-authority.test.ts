import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real history coordination and the real change feed; only fetch, the stream body, page
// activity and clocks are stand-ins. Needs --experimental-transform-types (apps/client).
const syncPath = fileURLToPath(new URL("../../apps/pool/ui/history-sync.ts", import.meta.url));

/** `apps/client` as `history-sync.ts` itself resolves it, so `ChangeReadRetry` is one class. */
async function appsClient() {
  for (let directory = dirname(syncPath); ; directory = dirname(directory)) {
    const manifest = join(directory, "node_modules", "apps", "package.json");
    if (existsSync(manifest)) {
      const entry = JSON.parse(readFileSync(manifest, "utf8")).exports["./client"];
      const file = typeof entry === "string" ? entry : (entry.import ?? entry.default);
      return import(pathToFileURL(join(dirname(manifest), file)).href);
    }
    if (dirname(directory) === directory) throw new Error("apps is not installed for the pool UI");
  }
}

const globals = globalThis as { window?: unknown; document?: unknown };
globals.window ??= { addEventListener() {}, removeEventListener() {} };
globals.document ??= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};
const { makeChangeFeed } = await appsClient();
const { syncHistory } = await import(pathToFileURL(syncPath).href);

const STREAM = "/_executor/api/changes";
const CURRENT = `${STREAM}/current`;
const encoder = new TextEncoder();

function backend() {
  const heads = new Map([
    ["apps", "1"],
    ["membership", "1"],
    ["session", "1"],
    ["pool-usage", "1"],
    ["pool-samples", "1"],
    ["pool-prices", "1"],
  ]);
  const state = { role: "manager", currentStatus: 200 };
  const streams: Array<{
    controller: ReadableStreamDefaultController<Uint8Array>;
    closed: boolean;
  }> = [];
  const revisions = () =>
    [...heads].map(([topic, revision]) => ({ topic, resource: "pool-a", revision }));
  const fetch = async (url: string, init?: RequestInit) => {
    if (url === STREAM) {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start: (opened) => {
          controller = opened;
        },
      });
      const entry = { controller, closed: false };
      init?.signal?.addEventListener("abort", () => {
        if (entry.closed) return;
        entry.closed = true;
        controller.error(new DOMException("aborted", "AbortError"));
      });
      streams.push(entry);
      return new Response(body, { status: 200 });
    }
    assert.equal(url, CURRENT);
    if (state.currentStatus !== 200) return new Response(null, { status: state.currentStatus });
    return new Response(JSON.stringify({ revisions: revisions(), identity: "viewer-a" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const send = (event: string, data: unknown) => {
    const entry = streams.at(-1);
    assert.ok(entry && !entry.closed, "a stream is open");
    entry.controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  return {
    state,
    fetch,
    handshake: () =>
      send("current", {
        kind: "current",
        revisions: revisions(),
        snapshotRequired: true,
        identity: "viewer-a",
      }),
    commit: (topic: string, revision: string) => {
      heads.set(topic, revision);
      send("changed", { kind: "changed", hint: { topic, resource: "pool-a", revision } });
    },
    closeAll: () => {
      for (const entry of streams) {
        if (entry.closed) continue;
        entry.closed = true;
        entry.controller.close();
      }
    },
  };
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const server = backend();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.fetch as typeof fetch;
  const feed = makeChangeFeed({
    stream: STREAM,
    current: CURRENT,
    activity: { isActive: () => true, onActiveChange: () => () => undefined },
  });
  /** Everything the history showed or was told, in order. */
  const log: Array<
    | { readonly kind: "apply"; readonly body: string; readonly reset: boolean }
    | { readonly kind: "clear" }
    | { readonly kind: "rejected"; readonly resetOwed: boolean }
  > = [];
  let held: Promise<void> | undefined;
  let reads = 0;
  const sync = syncHistory(feed, {
    read: async () => {
      reads++;
      // The body belongs to the grant in force when the data read started.
      const body = server.state.role;
      await held;
      return body;
    },
    apply: (body: string, reset: boolean) => log.push({ kind: "apply", body, reset }),
    clear: () => log.push({ kind: "clear" }),
    rejected: (_error: unknown, resetOwed: boolean) => log.push({ kind: "rejected", resetOwed }),
    reading: () => undefined,
    revoked: () => undefined,
  });
  t.after(() => {
    sync.stop();
    feed.close();
    server.closeAll();
    globalThis.fetch = originalFetch;
  });
  const flush = async () => {
    for (let index = 0; index < 50; index++) {
      t.mock.timers.tick(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const hold = () => {
    let release!: () => void;
    held = new Promise((resolve) => {
      release = resolve;
    });
    return () => {
      held = undefined;
      release();
    };
  };
  return { server, sync, log, flush, hold, reads: () => reads };
}

const applied = (log: ReadonlyArray<{ kind: string }>) =>
  log.filter(
    (entry): entry is { kind: "apply"; body: string; reset: boolean } => entry.kind === "apply",
  );

test("a held manager body is never published across a demotion; the member reset replaces it", async (t) => {
  const { server, log, flush, hold, reads } = setup(t);
  await flush();
  server.handshake();
  await flush();
  assert.deepEqual(log, [{ kind: "apply", body: "manager", reset: false }], "one initial read");
  assert.equal(reads(), 1);

  // A usage refresh captures the manager's body and is held.
  const release = hold();
  server.commit("pool-usage", "2");
  await flush();
  // Demoted to member while that body is in flight.
  server.state.role = "member";
  server.commit("membership", "2");
  await flush();
  assert.deepEqual(
    log.at(-1),
    { kind: "clear" },
    "the history clears on the hint, before any reply",
  );
  release();
  await flush();

  const afterClear = log.slice(log.findIndex((entry) => entry.kind === "clear") + 1);
  assert.ok(
    applied(afterClear).every((entry) => entry.body === "member"),
    "no manager body is published after the demotion was observed",
  );
  assert.deepEqual(applied(log).at(-1), { kind: "apply", body: "member", reset: true });
});

test("a failed replacement keeps the reset owed and never keeps the old grant", async (t) => {
  const { server, sync, log, flush } = setup(t);
  await flush();
  server.handshake();
  await flush();
  server.state.currentStatus = 503;
  server.state.role = "member";
  server.commit("membership", "2");
  await flush();
  assert.ok(log.some((entry) => entry.kind === "clear"));
  assert.deepEqual(log.at(-1), { kind: "rejected", resetOwed: true }, "the reset is still owed");

  server.state.currentStatus = 200;
  sync.request();
  await flush();
  assert.deepEqual(log.at(-1), { kind: "apply", body: "member", reset: true });
  assert.ok(
    !applied(log.slice(1)).some((entry) => entry.body === "manager"),
    "the manager body never returned",
  );
});

test("usage-only changes keep the history and read once, without a reset", async (t) => {
  const { server, log, flush, reads } = setup(t);
  await flush();
  server.handshake();
  await flush();
  server.commit("pool-usage", "2");
  await flush();
  assert.deepEqual(log, [
    { kind: "apply", body: "manager", reset: false },
    { kind: "apply", body: "manager", reset: false },
  ]);
  assert.equal(reads(), 2, "one data read per hint");
});

test("an authority hint costs one data read, not a duplicate cycle", async (t) => {
  const { server, log, flush, reads } = setup(t);
  await flush();
  server.handshake();
  await flush();
  server.state.role = "member";
  server.commit("membership", "2");
  await flush();
  assert.equal(reads(), 2);
  assert.deepEqual(log.slice(1), [
    { kind: "clear" },
    { kind: "apply", body: "member", reset: true },
  ]);
});
