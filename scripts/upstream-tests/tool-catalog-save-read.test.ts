import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AtomRegistry as RegistryType } from "effect/reactivity";

// The real hosted manager contract, atom registry and a real DOM; only the API client is a fake.
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

// Resolved from the contract's directory, so the test and the contract share one copy of effect.
const require = createRequire(contractPath);

// One page, in happy-dom, which the hosted web package already depends on: the dashboard's
// revalidated reads listen for its visibility events. It is registered before those modules load,
// at a dashboard origin, because the browser's auth client is addressed through the page's. A
// listener that throws fails the test instead of being logged, as happy-dom does by default.
const { GlobalRegistrator } = await import(require.resolve("@happy-dom/global-registrator"));
GlobalRegistrator.register({
  url: "https://dashboard.invalid/",
  settings: { errorCapture: "disabled" },
});
after(() => GlobalRegistrator.unregister());
// The browser fires this at the visible document, and it bubbles to the window.
const returnToPage = () => document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));

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

/** Every wait here is for an event that comes at once or never: it fails by name, not by hanging. */
const deadline = (what: () => string, fail: (error: Error) => void) =>
  setTimeout(() => fail(new Error(`waited 10 s for ${what()}`)), 10_000).unref();

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
  const nth = (queue: Held[], index: number, what: string) =>
    new Promise<Held>((resolve, reject) => {
      const timer = deadline(() => `${what} #${index}; ${queue.length} arrived`, reject);
      const check = () => {
        if (!queue[index]) {
          waiters.push(check);
          return;
        }
        clearTimeout(timer);
        resolve(queue[index]);
      };
      check();
    });
  return {
    client: {
      toolAvailability: { list: held(reads), update: held(saves) },
      tools: { index: () => Effect.never },
    },
    read: (index: number) => nth(reads, index, "list read"),
    save: (index: number) => nth(saves, index, "save"),
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
  new Promise<Result>((resolve, reject) => {
    let last: Result | undefined;
    const timer = deadline(
      () => `an accepted value; last ${last?._tag} [${last && names(last)}]`,
      (error) => {
        cancel();
        reject(error);
      },
    );
    const cancel = registry.subscribe(
      atom as never,
      (value: Result) => {
        last = value;
        if (!done(value)) return;
        clearTimeout(timer);
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

test("the read a save starts keeps the catalog on screen and then shows the host's answer", async (t) => {
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
});

test("a return to the page shows no catalog until its read answers", async (t) => {
  const { backend, registry, catalog } = await open(t);
  returnToPage();
  const read = await backend.read(1);
  assert.equal((registry.get(catalog) as Result)._tag, "Initial");
  read.answer(list(1, [REVIEW]));
  await until(registry, catalog, shows(REVIEW.name));
});

test("a linked-account change shows no catalog until discovery answers", async (t) => {
  const { backend, registry, catalog } = await open(t);
  refreshToolAvailabilityDiscovery({ registry } as never, KEY);
  const read = await backend.read(1);
  assert.equal((registry.get(catalog) as Result)._tag, "Initial");
  read.answer(list(1, [REVIEW]));
  await until(registry, catalog, shows(REVIEW.name));
});

test("a linked-account change during the save's own read shows no catalog until discovery answers", async (t) => {
  const { backend, registry, catalog, saved } = await open(t);
  await saved();
  refreshToolAvailabilityDiscovery({ registry } as never, KEY);
  assert.equal((registry.get(catalog) as Result)._tag, "Initial");
  backend.answerReads(list(2, [REVIEW]));
  await until(registry, catalog, shows(REVIEW.name));
});

for (const [view, ask] of [
  ["Retry or Refresh tools on the catalog", "catalog"],
  ["Reload on the setting", "settings"],
] as const)
  test(`${view} during the save's own read shows no catalog until the read answers`, async (t) => {
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
  });

test("a save whose own read fails shows the failure without the previous catalog", async (t) => {
  const { registry, catalog, saved } = await open(t);
  (await saved()).fail({ _tag: "ToolAvailabilityUnavailable" });
  const failed = await until(registry, catalog, (value) => value._tag === "Failure");
  assert.equal(
    (AsyncResult.value(failed) as { _tag: string })._tag,
    "None",
    "a failed read keeps no earlier tools",
  );
});
