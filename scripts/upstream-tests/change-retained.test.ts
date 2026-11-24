import assert from "node:assert/strict";
import type { Atom as AtomType, AtomRegistry as RegistryType } from "effect/reactivity";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The real dashboard adapter, registry and feed; only fetch, the stream body and clocks are fakes.
const signalPath = fileURLToPath(
  new URL("../../.upstream/apps/hosted/web/src/contracts/change-signal.ts", import.meta.url),
);

/** Resolve a subpath of `effect` from the adapter's own directory so both share one copy. */
async function effectModule(subpath: "." | "./reactivity") {
  for (let directory = dirname(signalPath); ; directory = dirname(directory)) {
    const manifest = join(directory, "node_modules", "effect", "package.json");
    if (existsSync(manifest)) {
      const exported = JSON.parse(readFileSync(manifest, "utf8")).exports[subpath];
      const pick = (entry: unknown): string =>
        typeof entry === "string"
          ? entry
          : pick(
              (entry as Record<string, unknown>).import ??
                (entry as Record<string, unknown>).default,
            );
      return import(pathToFileURL(join(dirname(manifest), pick(exported))).href);
    }
    if (dirname(directory) === directory)
      throw new Error("effect is not installed for the adapter");
  }
}

const globals = globalThis as { window?: unknown; document?: unknown };
globals.window ??= { addEventListener() {}, removeEventListener() {} };
globals.document ??= {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};
const { Atom, AtomRegistry, AsyncResult } = await effectModule("./reactivity");
const { Cause } = await effectModule(".");
const { changeProtected } = await import(pathToFileURL(signalPath).href);

const ORGANIZATION = "org-a";
const STREAM = `/api/organizations/${ORGANIZATION}/changes`;
const CURRENT = `${STREAM}/current`;
const encoder = new TextEncoder();

type Result = {
  readonly _tag: "Initial" | "Success" | "Failure";
  readonly waiting: boolean;
  readonly value?: unknown;
  readonly cause?: unknown;
  readonly previousSuccess?: {
    readonly _tag: "Some" | "None";
    readonly value?: { value: unknown };
  };
};

/** Every body a published value would show, including a failure's retained one. */
const bodies = (values: readonly Result[]) =>
  values.flatMap((value) =>
    value._tag === "Success"
      ? [value.value]
      : value._tag === "Failure" && value.previousSuccess?._tag === "Some"
        ? [value.previousSuccess.value?.value]
        : [],
  );
const errorTag = (value: Result) => {
  const error = Cause.findErrorOption(value.cause);
  return error._tag === "Some" ? (error.value as { _tag: string })._tag : undefined;
};

function backend() {
  const heads = new Map([
    ["accounts", "1"],
    ["session", "1"],
  ]);
  const state = { identity: "viewer-a", streamOpens: 0, currentReads: 0, urls: [] as string[] };
  const streams: Array<{
    controller: ReadableStreamDefaultController<Uint8Array>;
    closed: boolean;
  }> = [];
  let gate: Promise<void> | undefined;
  let releaseGate: (() => void) | undefined;
  let nextHold: Promise<void> | undefined;
  const revisions = () =>
    [...heads].map(([topic, revision]) => ({ topic, resource: ORGANIZATION, revision }));
  const fetch = async (url: string, init?: RequestInit) => {
    state.urls.push(url);
    const pathname = url.split("?")[0];
    if (pathname === STREAM) {
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
    assert.equal(pathname, CURRENT);
    state.currentReads++;
    // A held read answers with the heads it saw when it was sent, like a slow response.
    const hold = nextHold;
    nextHold = undefined;
    const sent = revisions();
    await hold;
    await gate;
    return new Response(JSON.stringify({ revisions: hold ? sent : revisions(), identity: state.identity }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const send = (index: number, event: string, data: unknown) => {
    const entry = streams.at(index);
    assert.ok(entry && !entry.closed, "the stream is open");
    entry.controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  return {
    heads,
    state,
    fetch,
    streamOpen: (index = -1) => streams.at(index)?.closed === false,
    send,
    handshake: (index = -1) =>
      send(index, "current", {
        kind: "current",
        revisions: revisions(),
        snapshotRequired: true,
        identity: state.identity,
      }),
    commit: (topic: string, revision: string, index = -1) => {
      heads.set(topic, revision);
      send(index, "changed", {
        kind: "changed",
        hint: { topic, resource: ORGANIZATION, revision },
      });
    },
    /** Holds every head read from now until released. */
    holdCurrent: () => {
      let release!: () => void;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      releaseGate = () => {
        gate = undefined;
        release();
      };
      return releaseGate;
    },
    /** Holds only the next head read, which then answers with the heads it was sent at. */
    holdNextCurrent: () => {
      let release!: () => void;
      nextHold = new Promise((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    /** Ends every open stream and held head read, so a failed case leaves nothing running. */
    closeAll: () => {
      releaseGate?.();
      for (const entry of streams) {
        if (entry.closed) continue;
        entry.closed = true;
        entry.controller.close();
      }
    },
  };
}

/** A source whose loads resolve only when the test says so, recording which registry asked. */
function source(retained?: unknown) {
  const loads: Array<{
    registry: unknown;
    resolve: (value: unknown) => void;
  }> = [];
  let first = retained;
  const atom = Atom.readable((get: AtomType.AtomContext) => {
    if (first !== undefined) {
      const value = first;
      first = undefined;
      return AsyncResult.success(value);
    }
    // No guard: a superseded load may still try to publish, as a careless source could.
    loads.push({
      registry: get.registry,
      resolve: (value) => {
        try {
          get.setSelf(AsyncResult.success(value));
        } catch {
          // A registry may refuse writes from a disposed build; that is also acceptable.
        }
      },
    });
    return AsyncResult.initial(true);
  });
  return { atom, loads };
}

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const server = backend();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.fetch as typeof fetch;
  const registries = new Set<RegistryType.AtomRegistry>();
  // Runs even when an assertion fails: dispose every registry (stopping its watches), end the fake
  // streams so no read stays pending, then restore fetch.
  t.after(() => {
    for (const registry of registries) registry.dispose();
    server.closeAll();
    globalThis.fetch = originalFetch;
  });
  const flush = async () => {
    for (let index = 0; index < 50; index++) {
      t.mock.timers.tick(0);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const mount = <A extends Result>(registry: RegistryType.AtomRegistry, atom: AtomType.Atom<A>) => {
    registries.add(registry);
    const values: Result[] = [];
    const stop = registry.subscribe(atom, (value: A) => values.push(value));
    values.push(registry.get(atom));
    return { values, stop, current: () => registry.get(atom) as Result };
  };
  return { server, flush, mount };
}

test("an unconfirmed retained value is never shown, and a body waits for its after-read", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source("retained-old");
  const registry = AtomRegistry.make();
  registry.get(src.atom);
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const view = mount(registry, atom);
  await flush();
  assert.equal(server.state.streamOpens, 1);
  assert.deepEqual(bodies(view.values), [], "the retained value is not shown before a fenced read");
  server.handshake();
  await flush();
  assert.equal(src.loads.length, 1, "the fenced read asked the source for a fresh load");
  const release = server.holdCurrent();
  src.loads[0]!.resolve("fresh-1");
  await flush();
  assert.deepEqual(bodies(view.values), [], "the body stays buffered until its after-read");
  assert.equal(view.current().waiting, true);
  release();
  await flush();
  assert.equal(view.current()._tag, "Success");
  assert.equal(view.current().value, "fresh-1");
  assert.ok(!bodies(view.values).includes("retained-old"));
  view.stop();
});

test("revocation clears accepted content instead of retaining it", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const view = mount(AtomRegistry.make(), atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("fresh-1");
  await flush();
  assert.equal(view.current().value, "fresh-1");
  server.send(-1, "revoked", {});
  await flush();
  const result = view.current();
  assert.equal(result._tag, "Failure");
  assert.equal(errorTag(result), "OrganizationForbidden");
  assert.equal(result.previousSuccess?._tag, "None", "no protected body survives revocation");
  view.stop();
});

test("a rejected refresh keeps the confirmed body only as a failure, never as current", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const view = mount(AtomRegistry.make(), atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("fresh-1");
  await flush();
  // Heads keep moving under every attempt, so the read cannot be accepted.
  for (let revision = 2; revision <= 4; revision++) {
    server.commit("accounts", String(revision));
    await flush();
    server.heads.set("accounts", String(revision + 10));
    src.loads.at(-1)!.resolve(`moving-${revision}`);
    await flush();
  }
  assert.ok(
    view.values.some(
      (value) =>
        value._tag === "Failure" &&
        errorTag(value) === "ChangeRefreshFailed" &&
        value.previousSuccess?._tag === "Some" &&
        value.previousSuccess.value?.value === "fresh-1",
    ),
    "the rejected refresh was shown as a failure over the last confirmed body",
  );
  // The hints that arrived meanwhile start one real follow-up read; heads now hold still.
  src.loads.at(-1)!.resolve("settled");
  await flush();
  const result = view.current();
  assert.equal(result._tag, "Success");
  assert.equal(result.value, "settled");
  assert.equal(result.waiting, false, "a finished refresh never stays updating");
  assert.ok(
    !bodies(view.values).some((body) => String(body).startsWith("moving")),
    "no unaccepted body is ever published",
  );
  view.stop();
});

test("two registries on one atom each refresh only themselves", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const left = AtomRegistry.make();
  const right = AtomRegistry.make();
  const a = mount(left, atom);
  const b = mount(right, atom);
  await flush();
  assert.equal(server.state.streamOpens, 2, "each registry has its own feed");
  server.handshake(0);
  server.handshake(1);
  await flush();
  for (const load of src.loads) load.resolve(load.registry === left ? "left-1" : "right-1");
  await flush();
  assert.equal(a.current().value, "left-1");
  assert.equal(b.current().value, "right-1");
  const before = src.loads.length;
  left.refresh(atom);
  await flush();
  const asked = src.loads.slice(before);
  assert.ok(asked.length >= 1, "the refreshed registry read again");
  assert.ok(
    asked.every((load) => load.registry === left),
    "the other registry did not read",
  );
  assert.equal(b.current().waiting, false);
  a.stop();
  b.stop();
});

test("a write while a read is in flight never publishes its body", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const registry = AtomRegistry.make();
  const view = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("fresh-1");
  await flush();
  server.commit("accounts", "2");
  await flush();
  const inFlight = src.loads.at(-1)!;
  // What `acknowledge` and `readInto` write.
  registry.set(atom, () => "patched");
  registry.set(atom, (current: string) => `${current}-patched`);
  await flush();
  assert.ok(!bodies(view.values).some((body) => String(body).includes("patched")));
  inFlight.resolve("fresh-2");
  await flush();
  assert.equal(view.current().value, "fresh-2");
  const followUp = src.loads.at(-1)!;
  assert.notEqual(followUp, inFlight, "the write asked for one more fenced read");
  followUp.resolve("fresh-3");
  await flush();
  assert.equal(view.current().value, "fresh-3");
  assert.ok(!bodies(view.values).some((body) => String(body).includes("patched")));
  view.stop();
});

test("the source's own first load can never replace an accepted result", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const registry = AtomRegistry.make();
  registry.get(src.atom);
  const own = src.loads[0]!;
  const view = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  const fenced = src.loads.at(-1)!;
  assert.notEqual(fenced, own);
  // The superseded load lands while the fenced read is still waiting for its own body.
  own.resolve("stale-initial");
  await flush();
  fenced.resolve("fresh");
  await flush();
  own.resolve("stale-late");
  await flush();
  for (const load of src.loads.slice(src.loads.indexOf(fenced) + 1)) load.resolve("fresh-again");
  await flush();
  assert.ok(
    !bodies(view.values).some((body) => String(body).startsWith("stale")),
    "a superseded load's body was never shown",
  );
  assert.ok(String(view.current().value).startsWith("fresh"));
  view.stop();
});

test("remounting in the same registry after an identity swap never shows the old data", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const registry = AtomRegistry.make();
  const first = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("fresh-a");
  await flush();
  assert.equal(first.current().value, "fresh-a");
  first.stop();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  assert.equal(server.streamOpen(), false, "the unmounted read closed its stream");

  server.state.identity = "viewer-b";
  const second = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  assert.ok(!bodies(second.values).includes("fresh-a"), "viewer A's data never reached viewer B");
  assert.equal(second.current()._tag, "Failure");
  second.stop();
  await flush();

  const third = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("fresh-b");
  await flush();
  assert.equal(third.current().value, "fresh-b", "a new feed serves the new principal");
  assert.ok(!bodies(third.values).includes("fresh-a"));
  third.stop();
});

test("remounting confirms retained heads without fetching the body again", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const registry = AtomRegistry.make();
  const first = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("accepted");
  await flush();
  first.stop();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  const count = src.loads.length;
  const second = mount(registry, atom);
  await flush();
  assert.deepEqual(bodies(second.values), [], "a new connection must confirm authority first");
  server.handshake();
  await flush();
  assert.equal(second.current().value, "accepted");
  assert.equal(src.loads.length, count, "unchanged authorized heads reuse the accepted body");
  second.stop();
});

/** A view confirmed at a handshake without reading, beside a sibling view on the same feed. */
async function confirmedBesideSibling(t: TestContext) {
  const { server, flush, mount } = setup(t);
  const registry = AtomRegistry.make();
  const held = source();
  const heldAtom = changeProtected(ORGANIZATION, ["accounts"])(held.atom);
  const first = mount(registry, heldAtom);
  await flush();
  server.handshake();
  await flush();
  held.loads.at(-1)!.resolve("held-1");
  await flush();
  first.stop();
  await flush();
  t.mock.timers.tick(1_000);
  await flush();
  const view = mount(registry, heldAtom);
  await flush();
  server.handshake();
  await flush();
  assert.equal(view.current().value, "held-1");
  assert.equal(held.loads.length, 1, "the confirmed view owes no read");
  // A view on another topic of the same feed, which no accounts revision concerns.
  const unrelated = source();
  const unrelatedView = mount(
    registry,
    changeProtected(ORGANIZATION, ["observations"])(unrelated.atom),
  );
  await flush();
  unrelated.loads.at(-1)!.resolve("unrelated-1");
  await flush();
  assert.equal(unrelatedView.current().value, "unrelated-1");
  // The commit's hint is missed; only a sibling's own head reads can see it.
  server.heads.set("accounts", "2");
  const sibling = source();
  const siblingView = mount(registry, changeProtected(ORGANIZATION, ["accounts"])(sibling.atom));
  await flush();
  return { t, server, flush, held, view, sibling, siblingView, unrelated, unrelatedView };
}

test("a confirmed view reads again when a sibling's accepted read proves a missed hint", async (t) => {
  const { flush, held, view, sibling, siblingView, unrelated, unrelatedView } =
    await confirmedBesideSibling(t);
  sibling.loads.at(-1)!.resolve("sibling-2");
  await flush();
  assert.equal(siblingView.current().value, "sibling-2");
  assert.equal(held.loads.length, 2, "the stale view reads once for the head it missed");
  held.loads.at(-1)!.resolve("held-2");
  await flush();
  assert.equal(view.current().value, "held-2");
  assert.equal(view.current().waiting, false);
  assert.equal(held.loads.length, 2, "covered heads read nothing more");
  assert.equal(sibling.loads.length, 1, "the sibling is not asked back");
  assert.equal(unrelated.loads.length, 1, "a view on other topics is never asked");
  view.stop();
  siblingView.stop();
  unrelatedView.stop();
});

test("a sibling's moving-head failure fails a confirmed view closed, and settled heads recover it", async (t) => {
  const { server, flush, held, view, sibling, siblingView, unrelated, unrelatedView } =
    await confirmedBesideSibling(t);
  let revision = 2;
  const resolved = new Set<unknown>();
  const pending = () =>
    [...sibling.loads, ...held.loads].filter((load) => !resolved.has(load));
  // Heads move under every attempt of every read, so nothing can be accepted.
  for (let round = 0; pending().length > 0; round++) {
    assert.ok(round < 20, "reads stop once every view has failed");
    for (const load of pending()) {
      resolved.add(load);
      server.heads.set("accounts", String(++revision));
      load.resolve(`moving-${revision}`);
      await flush();
    }
  }
  assert.equal(errorTag(siblingView.current()), "ChangeRefreshFailed");
  const shown = view.current();
  assert.equal(shown._tag, "Failure");
  assert.equal(errorTag(shown), "ChangeRefreshFailed", "the stale view says it is unconfirmed");
  assert.equal(shown.previousSuccess?.value?.value, "held-1");
  // Each read makes at most three attempts, and a failed view is never asked again.
  assert.ok(sibling.loads.length <= 3, String(sibling.loads.length));
  assert.ok(held.loads.length - 1 <= 3, String(held.loads.length));
  assert.equal(unrelated.loads.length, 1, "a view on other topics is never asked");
  assert.ok(
    !bodies(view.values).some((body) => String(body).startsWith("moving")),
    "no unaccepted body is ever published",
  );

  // Heads settle; each failed view's own first reconfirm accepts current data.
  t.mock.timers.tick(1_000);
  await flush();
  for (const load of pending()) {
    resolved.add(load);
    load.resolve(`settled-${revision}`);
    await flush();
  }
  assert.equal(pending().length, 0, "recovery needs no further read");
  assert.equal(view.current()._tag, "Success");
  assert.equal(view.current().value, `settled-${revision}`);
  assert.equal(view.current().waiting, false);
  assert.equal(siblingView.current().value, `settled-${revision}`);
  assert.equal(siblingView.current().waiting, false);
  view.stop();
  siblingView.stop();
  unrelatedView.stop();
});

test("without a stream fence, a view that accepts heads older than a sibling settled mid-read reads once more", async (t) => {
  const { server, flush, mount } = setup(t);
  const registry = AtomRegistry.make();
  const first = source();
  const second = source();
  const firstAtom = changeProtected(ORGANIZATION, ["accounts"])(first.atom);
  const secondAtom = changeProtected(ORGANIZATION, ["accounts"])(second.atom);
  const firstView = mount(registry, firstAtom);
  const secondView = mount(registry, secondAtom);
  await flush();
  server.handshake();
  await flush();
  first.loads.at(-1)!.resolve("first-1");
  second.loads.at(-1)!.resolve("second-1");
  await flush();
  assert.equal(firstView.current().value, "first-1");
  assert.equal(secondView.current().value, "second-1");
  // A lost stream leaves no connection fence, so a slow read may accept heads older than a
  // sibling's until the reconnect, which this test never reaches.
  server.closeAll();
  await flush();

  // Both views start a read on heads 1; an acknowledgement asks for a read and keeps what is shown.
  registry.set(firstAtom, (current: string) => current);
  registry.set(secondAtom, (current: string) => current);
  await flush();
  // The first view's after-read is sent on heads 1 but answers late.
  const release = server.holdNextCurrent();
  first.loads.at(-1)!.resolve("first-1b");
  await flush();
  // A missed commit; the second view's own reads see it and accept while the first still reads.
  server.heads.set("accounts", "2");
  for (let round = 0; secondView.current().value !== "second-2"; round++) {
    assert.ok(round < 5, "the second view settles on the new head");
    second.loads.at(-1)!.resolve("second-2");
    await flush();
  }
  const reads = first.loads.length;
  release();
  await flush();
  assert.equal(firstView.current().value, "first-1b", "its own read was consistent on heads 1");
  assert.equal(first.loads.length, reads + 1, "it reads once more for the head the sibling saw");
  first.loads.at(-1)!.resolve("first-2");
  await flush();
  assert.equal(firstView.current().value, "first-2");
  assert.equal(firstView.current().waiting, false);
  assert.equal(first.loads.length, reads + 1, "covered heads read nothing more");
  firstView.stop();
  secondView.stop();
});

test("a changed head during a short unmount cannot reaccept the old raw body", async (t) => {
  const { server, flush, mount } = setup(t);
  const src = source();
  const atom = changeProtected(ORGANIZATION, ["accounts"])(src.atom);
  const registry = AtomRegistry.make({ defaultIdleTTL: 400 });
  const first = mount(registry, atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("revision-1");
  await flush();
  first.stop();
  await flush();
  server.commit("accounts", "2");
  await flush();
  const second = mount(registry, atom);
  await flush();
  assert.equal(
    src.loads.length,
    2,
    "the changed revision owes a new body despite the registry TTL",
  );
  assert.equal(second.current().waiting, true);
  src.loads.at(-1)!.resolve("revision-2");
  await flush();
  assert.equal(second.current().value, "revision-2");
  assert.ok(
    !second.values.some((value) => !value.waiting && bodies([value]).includes("revision-1")),
    JSON.stringify(second.values),
  );
  second.stop();
});

test("pool-scoped protected reads ignore unrelated and duplicate revisions and coalesce updates", async (t) => {
  const { server, flush, mount } = setup(t);
  server.heads.set("pool-usage", "1");
  server.heads.set("pool-readings", "1");
  const src = source();
  const atom = changeProtected(
    ORGANIZATION,
    ["membership", "pool-usage", "pool-prices"],
    ["app_a"],
  )(src.atom);
  const view = mount(AtomRegistry.make(), atom);
  await flush();
  server.handshake();
  await flush();
  src.loads.at(-1)!.resolve("initial");
  await flush();
  assert.equal(view.current().value, "initial");
  assert.ok(server.state.urls.every((url) => url.endsWith("?pool=app_a")));
  server.commit("pool-readings", "2");
  server.commit("pool-usage", "1");
  await flush();
  assert.equal(src.loads.length, 1, "unrelated and duplicate revisions read no body");
  server.commit("pool-usage", "2");
  await flush();
  server.commit("pool-usage", "3");
  server.commit("pool-usage", "3");
  await flush();
  src.loads.at(-1)!.resolve("outpaced");
  await flush();
  assert.equal(src.loads.length, 3, "the moving read retries the body once at the newest heads");
  src.loads.at(-1)!.resolve("latest");
  await flush();
  assert.equal(view.current().value, "latest");
  server.commit("pool-usage", "3");
  await flush();
  assert.equal(src.loads.length, 3);
  view.stop();
});
