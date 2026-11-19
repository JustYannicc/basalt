import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AtomRegistry as RegistryType } from "effect/reactivity";

// The real hosted manager contract and atom registry; only the API client and the page are fakes.
const contractPath = fileURLToPath(
  new URL("../../.upstream/apps/hosted/web/src/contracts/tool-availability.ts", import.meta.url),
);
const clientPath = fileURLToPath(
  new URL("../../.upstream/apps/hosted/web/src/contracts/api.ts", import.meta.url),
);

// The dashboard reads Vite's build flags when its modules load; this is the browser build.
const hooks = registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.startsWith("file:") || !url.endsWith(".ts") || loaded.source === undefined)
      return loaded;
    const source =
      typeof loaded.source === "string"
        ? loaded.source
        : new TextDecoder().decode(loaded.source as Uint8Array);
    return source.includes("import.meta.env")
      ? { ...loaded, source: source.replaceAll(/import\.meta\.env\.(?:SSR|DEV)\b/g, "false") }
      : loaded;
  },
});

// One page: returning to it is the visibility event the dashboard's revalidated reads follow.
const pageListeners = new Set<() => void>();
const globals = globalThis as { window?: unknown; document?: unknown };
globals.window = {
  addEventListener: (type: string, listener: () => void) => {
    if (type === "visibilitychange") pageListeners.add(listener);
  },
  removeEventListener: (type: string, listener: () => void) => {
    if (type === "visibilitychange") pageListeners.delete(listener);
  },
};
globals.document = {
  visibilityState: "visible",
  addEventListener() {},
  removeEventListener() {},
};
const returnToPage = () => {
  for (const listener of [...pageListeners]) listener();
};

// Resolved from the contract's directory, so the test and the contract share one copy of effect.
const require = createRequire(contractPath);
const { Atom, AtomRegistry, AsyncResult } = await import(require.resolve("effect/reactivity"));
const { Context, Effect } = await import(require.resolve("effect"));
const { HostedClient } = await import(pathToFileURL(clientPath).href);
const {
  refreshToolAvailabilityDiscovery,
  toolAvailabilityAtom,
  toolAvailabilityCatalogAtom,
  updateToolAvailabilityAtom,
} = await import(pathToFileURL(contractPath).href);
hooks.deregister();

const KEY = { organization: "fixture-organization", app: "app_fixture_availability" };
const tool = (name: string, readOnly: boolean) => ({ name, description: name, readOnly });
const READ = tool("counter.count", true);
const WRITE = tool("records.write", false);
const REVIEW = tool("records.review", false);
const list = (
  revision: number,
  items = [READ, WRITE],
  enabledTools = items.map((t) => t.name),
) => ({
  revision,
  defaultMode: "all",
  overrides: [],
  enabledTools,
  groups: [{ path: "counter", tools: [READ.name] }],
  catalog: { items, routers: [] },
});
const SAVED = { revision: 2, defaultMode: "all", overrides: [] };

type Result = {
  readonly _tag: "Initial" | "Success" | "Failure";
  readonly waiting: boolean;
  readonly value?: { readonly tools?: ReadonlyArray<{ readonly name: string }> };
};
interface Held {
  readonly answer: (value: unknown) => void;
  readonly fail: (error: unknown) => void;
}

/** A host whose list reads and saves answer only when the test says so. */
function host() {
  const reads: Held[] = [];
  const saves: Held[] = [];
  const waiters: Array<() => void> = [];
  const held = (queue: Held[]) => () =>
    Effect.callback((resume: (effect: unknown) => void) => {
      queue.push({
        answer: (value) => resume(Effect.succeed(value)),
        fail: (error) => resume(Effect.fail(error)),
      });
      for (const wake of waiters.splice(0)) wake();
      // A cleanup makes an interrupted read ignore a later answer.
      return Effect.void;
    });
  const nth = (queue: Held[], index: number) =>
    new Promise<Held>((resolve) => {
      const check = () => (queue[index] ? resolve(queue[index]) : waiters.push(check));
      check();
    });
  return {
    client: {
      toolAvailability: { list: held(reads), update: held(saves) },
      tools: { index: () => Effect.never },
    },
    read: (index: number) => nth(reads, index),
    save: (index: number) => nth(saves, index),
    /** A refresh restarts a read still in flight; answering every held read reaches the live one. */
    answerReads: (value: unknown) => {
      for (const read of reads) read.answer(value);
    },
  };
}

/** The value of `atom` once `done` accepts it. */
const until = (
  registry: RegistryType.AtomRegistry,
  atom: unknown,
  done: (value: Result) => boolean,
) =>
  new Promise<Result>((resolve) => {
    const cancel = registry.subscribe(
      atom as never,
      (value: Result) => {
        if (!done(value)) return;
        queueMicrotask(() => cancel());
        resolve(value);
      },
      { immediate: true },
    );
  });
const names = (result: Result) => result.value?.tools?.map((item) => item.name);
const shows =
  (...expected: string[]) =>
  (result: Result) =>
    result._tag === "Success" && names(result)?.join() === expected.join();

/** A manager's Tools tab: the catalog, the setting and its save, with the first read answered. */
async function open(t: TestContext) {
  const backend = host();
  const registry: RegistryType.AtomRegistry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(
        HostedClient.runtime,
        AsyncResult.success(Context.make(HostedClient, backend.client)),
      ),
    ],
  });
  t.after(() => registry.dispose());
  registry.mount(HostedClient.runtime);
  const catalog = toolAvailabilityCatalogAtom(KEY);
  const settings = toolAvailabilityAtom(KEY);
  const update = updateToolAvailabilityAtom(KEY);
  for (const atom of [catalog, settings, update]) registry.mount(atom);
  (await backend.read(0)).answer(list(1));
  await until(registry, catalog, shows(READ.name, WRITE.name));
  /** Saves a group change; the host confirms it and the read the save starts is held. */
  const saved = async () => {
    registry.set(update, {
      revision: 1,
      changes: [{ kind: "group", path: "counter", enabled: true }],
    });
    (await backend.save(0)).answer(SAVED);
    await until(registry, update, (value) => value._tag === "Success");
    return backend.read(1);
  };
  return { backend, registry, catalog, settings, saved };
}

test(
  "the read a save starts keeps the catalog on screen and then shows the host's answer",
  { timeout: 10_000 },
  async (t) => {
    const { registry, catalog, settings, saved } = await open(t);
    const reconciling = await saved();
    const held = registry.get(catalog) as Result;
    assert.equal(held._tag, "Success", "the save's own catalog read must not unmount the browser");
    assert.deepEqual(names(held), [READ.name, WRITE.name]);
    // The host also reports a tool the page had not seen, so the acknowledged catalog cannot stick.
    reconciling.answer(list(2, [READ, WRITE, REVIEW]));
    await until(registry, catalog, shows(READ.name, WRITE.name, REVIEW.name));
    const setting = registry.get(settings) as {
      value: { revision: number; enabledTools: string[] };
    };
    assert.equal(setting.value.revision, 2);
    assert.deepEqual(setting.value.enabledTools, [READ.name, WRITE.name, REVIEW.name]);
  },
);

test(
  "a return to the page shows no catalog until its read answers",
  { timeout: 10_000 },
  async (t) => {
    const { backend, registry, catalog } = await open(t);
    returnToPage();
    const read = await backend.read(1);
    assert.equal((registry.get(catalog) as Result)._tag, "Initial");
    read.answer(list(1, [REVIEW]));
    await until(registry, catalog, shows(REVIEW.name));
  },
);

test(
  "a linked-account change shows no catalog until discovery answers",
  { timeout: 10_000 },
  async (t) => {
    const { backend, registry, catalog } = await open(t);
    refreshToolAvailabilityDiscovery({ registry } as never, KEY);
    const read = await backend.read(1);
    assert.equal((registry.get(catalog) as Result)._tag, "Initial");
    read.answer(list(1, [REVIEW]));
    await until(registry, catalog, shows(REVIEW.name));
  },
);

test(
  "a linked-account change during the save's own read shows no catalog until discovery answers",
  { timeout: 10_000 },
  async (t) => {
    const { backend, registry, catalog, saved } = await open(t);
    await saved();
    refreshToolAvailabilityDiscovery({ registry } as never, KEY);
    assert.equal((registry.get(catalog) as Result)._tag, "Initial");
    backend.answerReads(list(2, [REVIEW]));
    await until(registry, catalog, shows(REVIEW.name));
  },
);

for (const [view, ask] of [
  ["Retry or Refresh tools on the catalog", "catalog"],
  ["Reload on the setting", "settings"],
] as const)
  test(
    `${view} during the save's own read shows no catalog until the read answers`,
    { timeout: 10_000 },
    async (t) => {
      const opened = await open(t);
      const { backend, registry, catalog } = opened;
      await opened.saved();
      registry.refresh(opened[ask]);
      assert.equal(
        (registry.get(catalog) as Result)._tag,
        "Initial",
        "asking again must not keep the previous catalog",
      );
      backend.answerReads(list(2, [REVIEW]));
      await until(registry, catalog, shows(REVIEW.name));
    },
  );

test(
  "a save whose own read fails shows the failure without the previous catalog",
  { timeout: 10_000 },
  async (t) => {
    const { registry, catalog, saved } = await open(t);
    (await saved()).fail({ _tag: "ToolAvailabilityUnavailable" });
    const failed = await until(registry, catalog, (value) => value._tag === "Failure");
    assert.equal(
      (AsyncResult.value(failed) as { _tag: string })._tag,
      "None",
      "a failed read keeps no earlier tools",
    );
  },
);
