import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { makeChangeFeed } from "../../.upstream/packages/apps/src/implementation/change-feed.ts";

// The real feed and fence; only fetch, the stream body, page activity and clocks are stand-ins.
const STREAM = "/changes";
const CURRENT = "/changes/current";
const START = 1_000_000;
const encoder = new TextEncoder();

/** Lets fetch, stream reads and promise chains settle; timers stay mocked. */
const flush = async () => {
  for (let index = 0; index < 50; index++)
    await new Promise<void>((resolve) => setImmediate(resolve));
};

function backend() {
  const heads = new Map([
    ["accounts", "1"],
    ["pool-usage", "1"],
    ["session", "1"],
  ]);
  const state = {
    identity: "viewer-a" as string | undefined,
    validUntil: undefined as number | undefined,
    streamOpens: 0,
    currentReads: 0,
  };
  const streams: Array<{
    controller: ReadableStreamDefaultController<Uint8Array>;
    closed: boolean;
  }> = [];
  const revisions = () =>
    [...heads].map(([topic, revision]) => ({ topic, resource: "pool-a", revision }));
  const fetch = async (url: string, init?: RequestInit) => {
    if (url === STREAM) {
      state.streamOpens++;
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
    state.currentReads++;
    return new Response(
      JSON.stringify({
        revisions: revisions(),
        ...(state.identity === undefined ? {} : { identity: state.identity }),
        ...(state.validUntil === undefined ? {} : { validUntil: state.validUntil }),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const open = () => {
    const entry = streams.at(-1);
    assert.ok(entry && !entry.closed, "a stream is open");
    return entry;
  };
  const send = (event: string, data: unknown) =>
    open().controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  return {
    heads,
    state,
    fetch,
    streamOpen: () => streams.at(-1)?.closed === false,
    send,
    handshake: (extras: { readonly validUntil?: number } = {}) =>
      send("current", {
        kind: "current",
        revisions: revisions(),
        snapshotRequired: true,
        ...(state.identity === undefined ? {} : { identity: state.identity }),
        ...extras,
      }),
    /** Commit a revision; with `notify`, the stream hints it like the dispatcher would. */
    commit: (topic: string, revision: string, notify = true) => {
      heads.set(topic, revision);
      if (notify)
        send("changed", { kind: "changed", hint: { topic, resource: "pool-a", revision } });
    },
    hint: (topic: string, revision: string) =>
      send("changed", { kind: "changed", hint: { topic, resource: "pool-a", revision } }),
    drop: () => {
      const entry = open();
      entry.closed = true;
      entry.controller.close();
    },
  };
}

function setup(t: TestContext, topics: readonly string[] = ["accounts", "session"]) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: START });
  const server = backend();
  const originalFetch = globalThis.fetch;
  const globals = globalThis as { window?: unknown };
  const originalWindow = globals.window;
  globalThis.fetch = server.fetch as typeof fetch;
  globals.window = { addEventListener() {}, removeEventListener() {} };
  let active = true;
  const listeners = new Set<(active: boolean) => void>();
  const page = {
    isActive: () => active,
    onActiveChange: (listener: (active: boolean) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    show: (next: boolean) => {
      active = next;
      for (const listener of listeners) listener(next);
    },
  };
  const feed = makeChangeFeed({ stream: STREAM, current: CURRENT, activity: page });
  const seen = {
    refreshes: 0,
    dataReads: 0,
    revoked: 0,
    applied: [] as Array<Record<string, string>>,
    rejected: [] as unknown[],
  };
  let held: Promise<void> | undefined;
  /** Holds the next data reads until the returned function releases them. */
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
  const watch = feed.watch({
    topics,
    refresh: async () => {
      seen.refreshes++;
      try {
        seen.applied.push(
          await watch.read(async () => {
            seen.dataReads++;
            // The body is what the backend held when the data read started.
            const body = Object.fromEntries(server.heads);
            await held;
            return body;
          }),
        );
      } catch (error) {
        seen.rejected.push(error);
      }
    },
    revoked: () => {
      seen.revoked++;
    },
  });
  t.after(() => {
    feed.close();
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
  });
  return { server, feed, watch, page, seen, hold };
}

test("nothing reads before the handshake; a committed revision reads once and repeats read nothing", async (t) => {
  const { server, seen } = setup(t);
  await flush();
  assert.equal(server.state.streamOpens, 1);
  assert.equal(seen.dataReads, 0, "no snapshot is forced before the handshake");
  server.handshake();
  await flush();
  assert.equal(seen.refreshes, 1);
  assert.deepEqual(seen.applied.at(-1), { accounts: "1", "pool-usage": "1", session: "1" });

  server.commit("accounts", "2");
  await flush();
  assert.equal(seen.refreshes, 2);
  assert.equal(seen.applied.at(-1)?.accounts, "2");

  // A duplicate, an older one, and a topic this watch does not read.
  server.hint("accounts", "2");
  server.hint("accounts", "1");
  server.commit("pool-usage", "7");
  await flush();
  assert.equal(seen.refreshes, 2, "covered and unrelated hints read nothing");
  assert.equal(seen.dataReads, 2);
});

test("hints during a read coalesce, and the read never shows an outpaced body", async (t) => {
  const { server, seen, hold } = setup(t);
  await flush();
  server.handshake();
  await flush();
  const release = hold();
  server.commit("accounts", "2");
  await flush();
  assert.equal(seen.refreshes, 2);
  server.commit("accounts", "3");
  server.commit("accounts", "4");
  await flush();
  release();
  await flush();
  assert.equal(seen.refreshes, 2, "the in-flight read absorbed both hints");
  assert.deepEqual(
    seen.applied.map((body) => body.accounts),
    ["1", "4"],
    "the body read at revision 2 was rejected by its after-read and never applied",
  );
  assert.equal(seen.dataReads, 3, "one retry inside the same refresh");
});

test("a request made during a read is not lost", async (t) => {
  const { server, watch, seen, hold } = setup(t);
  await flush();
  server.handshake();
  await flush();
  const release = hold();
  watch.request();
  await flush();
  assert.equal(seen.refreshes, 2);
  watch.request();
  release();
  await flush();
  assert.equal(seen.refreshes, 3, "the mid-read request reads once more");
  await flush();
  assert.equal(seen.refreshes, 3);
});

test("a hidden page reads nothing; showing it handshakes and reads only if heads moved", async (t) => {
  const { server, page, seen } = setup(t);
  await flush();
  server.handshake();
  await flush();
  page.show(false);
  await flush();
  assert.equal(server.streamOpen(), false, "hidden pages hold no stream");
  const before = { ...server.state };
  server.commit("accounts", "2", false);
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(server.state.currentReads, before.currentReads);
  assert.equal(seen.dataReads, 1);

  page.show(true);
  await flush();
  assert.equal(server.state.streamOpens, 2);
  assert.equal(seen.dataReads, 1, "showing the page reads nothing before its handshake");
  server.handshake();
  await flush();
  assert.equal(seen.refreshes, 2);
  assert.equal(seen.applied.at(-1)?.accounts, "2");

  page.show(false);
  page.show(true);
  await flush();
  server.handshake();
  await flush();
  assert.equal(seen.refreshes, 2, "the same heads after a return read nothing");
});

test("a reconnect reads once for missed heads and never for unchanged ones", async (t) => {
  const { server, seen } = setup(t);
  await flush();
  server.handshake();
  await flush();
  server.drop();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(server.state.streamOpens, 2);
  server.handshake();
  await flush();
  assert.equal(seen.refreshes, 1, "same heads: zero reads");

  server.drop();
  server.commit("accounts", "2", false);
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(server.state.streamOpens, 3);
  server.handshake();
  await flush();
  assert.equal(seen.refreshes, 2, "missed heads: exactly one read");
  assert.equal(seen.applied.at(-1)?.accounts, "2");
});

test("revocation discards the in-flight body and ends the feed", async (t) => {
  const { server, feed, seen, hold } = setup(t);
  await flush();
  server.handshake();
  await flush();
  const release = hold();
  server.commit("accounts", "2");
  await flush();
  server.send("revoked", {});
  await flush();
  assert.equal(seen.revoked, 1);
  release();
  await flush();
  assert.equal(seen.applied.length, 1, "the body read before revocation is never applied");
  assert.equal(seen.rejected.length, 1);
  assert.equal(feed.status(), "revoked");
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(server.state.streamOpens, 1, "a revoked feed never reconnects");
});

test("a changed identity ends access and discards the old principal's body", async (t) => {
  const { server, feed, seen, hold } = setup(t);
  await flush();
  server.handshake();
  await flush();
  const release = hold();
  server.commit("accounts", "2");
  await flush();
  // Signed out and in as someone else while the data read was in flight.
  server.state.identity = "viewer-b";
  release();
  await flush();
  assert.equal(seen.revoked, 1);
  assert.equal(seen.applied.length, 1);
  assert.equal(feed.status(), "revoked");
});

test("heads missing their identity after one was recorded are never accepted", async (t) => {
  const { server, feed, seen } = setup(t);
  await flush();
  server.handshake();
  await flush();
  server.state.identity = undefined;
  server.commit("accounts", "2");
  await flush();
  assert.equal(seen.applied.length, 1);
  assert.equal(seen.rejected.length, 1);
  assert.notEqual(feed.status(), "revoked", "a missing identity rejects without ending access");
});

test("the earliest server deadline reads once and survives a later accepted read", async (t) => {
  const { server, seen } = setup(t);
  await flush();
  server.state.validUntil = START + 60_000;
  server.handshake({ validUntil: START + 5_000 });
  await flush();
  assert.equal(seen.refreshes, 1);
  t.mock.timers.tick(4_999);
  await flush();
  assert.equal(seen.refreshes, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(seen.refreshes, 2, "the handshake deadline was kept by the accepted read");
  await flush();
  assert.equal(seen.refreshes, 2, "a passed deadline does not read again in a loop");
  t.mock.timers.tick(55_000);
  await flush();
  assert.equal(seen.refreshes, 3, "the head route's later deadline still applies");
});

test("a stream lost during a read is never accepted as live", async (t) => {
  const { server, feed, seen, hold } = setup(t);
  await flush();
  server.handshake();
  await flush();
  const release = hold();
  server.commit("accounts", "2");
  await flush();
  server.drop();
  await flush();
  release();
  await flush();
  assert.equal(seen.dataReads, 3, "the read that began on the lost connection was redone");
  assert.equal(seen.applied.at(-1)?.accounts, "2");
  assert.equal(feed.status(), "paused", "data accepted without a stream is labelled, not live");
});

test("a stream that never handshakes reads once and says live updates are paused", async (t) => {
  const { server, feed, seen } = setup(t);
  await flush();
  assert.equal(seen.dataReads, 0);
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(seen.refreshes, 1);
  assert.equal(seen.applied.length, 1);
  assert.equal(feed.status(), "paused");
  assert.ok(server.state.currentReads >= 2);
});

test("a read hidden mid-flight does no more data work until the foreground handshake", async (t) => {
  const { server, page, seen, hold } = setup(t);
  await flush();
  server.handshake();
  await flush();
  const release = hold();
  server.commit("accounts", "2");
  await flush();
  assert.equal(seen.dataReads, 2);
  // Heads move under the held read, so it would otherwise retry with more data work.
  server.commit("accounts", "3");
  await flush();
  page.show(false);
  await flush();
  release();
  await flush();
  assert.equal(seen.dataReads, 2, "no retry ran while hidden");
  assert.equal(seen.applied.length, 1, "the outpaced body was not applied");
  t.mock.timers.tick(10 * 60_000);
  await flush();
  assert.equal(seen.dataReads, 2, "a hidden page makes no reads at all");
  page.show(true);
  await flush();
  assert.equal(seen.dataReads, 2, "nothing reads before the foreground handshake");
  server.handshake();
  await flush();
  assert.equal(seen.dataReads, 3, "the parked read runs once after the handshake");
  assert.equal(seen.applied.at(-1)?.accounts, "3");
});
