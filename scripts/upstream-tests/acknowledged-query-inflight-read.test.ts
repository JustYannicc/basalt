import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { after, test, type TestContext } from "node:test";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AtomRegistry as RegistryType } from "effect/reactivity";

// The real hosted manager contract, the shared `acknowledgedQuery` under it, a real atom registry
// and a real DOM. The host's answers come through the API client, which answers when told to.
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
const { toolAvailabilityAtom, toolAvailabilityCatalogAtom, updateToolAvailabilityAtom } =
  await import(pathToFileURL(contractPath).href);
hooks.deregister();

const KEY = { organization: "fixture-organization", app: "app_fixture_availability" };
const tool = (name: string, readOnly: boolean) => ({ name, description: name, readOnly });
const READ = tool("counter.count", true);
const WRITE = tool("records.write", false);
const REVIEW = tool("records.review", false);
const list = (revision: number, items = [READ, WRITE]) => ({
  revision,
  defaultMode: "all",
  overrides: [],
  enabledTools: items.map((item) => item.name),
  groups: [{ path: "counter", tools: [READ.name] }],
  catalog: { items, routers: [] },
});
const CHANGE = { revision: 1, changes: [{ kind: "group", path: "counter", enabled: true }] };
const SAVED = { revision: 2, defaultMode: "all", overrides: [] };
/** What the host holds once another manager has saved too: a later revision and a new tool. */
const ANSWER = list(3, [READ, WRITE, REVIEW]);

type Result = {
  readonly _tag: "Initial" | "Success" | "Failure";
  readonly waiting: boolean;
  readonly value?: {
    readonly revision?: number;
    readonly enabledTools?: ReadonlyArray<string>;
    readonly tools?: ReadonlyArray<{ readonly name: string }>;
  };
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
    /** A confirmed save restarts a read still in flight; settling every held read reaches the live one. */
    answerReads: (value: unknown) => {
      for (const read of reads) read.answer(value);
    },
    failReads: (error: unknown) => {
      for (const read of reads) read.fail(error);
    },
  };
}

const show = (result: Result | undefined) =>
  `${result?._tag}${result?.waiting ? " waiting" : ""} revision ${result?.value?.revision}`;

/** The value of `atom` once `done` accepts it. */
const until = (
  registry: RegistryType.AtomRegistry,
  atom: unknown,
  done: (value: Result) => boolean,
) =>
  new Promise<Result>((resolve, reject) => {
    let last: Result | undefined;
    const timer = deadline(
      () => `an accepted value; last ${show(last)}`,
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
const tools = (result: Result) => result.value?.tools?.map((item) => item.name);

/** A manager's Tools tab: the setting, its catalog and its save, with the first read answered. */
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
  const setting = toolAvailabilityAtom(KEY);
  const catalog = toolAvailabilityCatalogAtom(KEY);
  const update = updateToolAvailabilityAtom(KEY);
  for (const atom of [setting, catalog, update]) registry.mount(atom);
  (await backend.read(0)).answer(list(1));
  await until(registry, setting, (value) => value._tag === "Success" && !value.waiting);
  /** The host confirms the save that `registry.set(update, CHANGE)` sent. */
  const confirm = async () => {
    (await backend.save(0)).answer(SAVED);
    await until(registry, update, (value) => value._tag === "Success");
    return registry.get(setting) as Result;
  };
  return { backend, registry, setting, catalog, update, confirm };
}
type Opened = Awaited<ReturnType<typeof open>>;

/** Another read of the list that can be in flight when the host confirms a save. */
const otherReads: ReadonlyArray<readonly [string, (opened: Opened) => void]> = [
  ["a return to the page", returnToPage],
  ["a manager's reload", ({ registry, setting }) => registry.refresh(setting)],
];

for (const [reading, start] of otherReads)
  test(`a save confirmed during ${reading} shows the saved setting and still waits for that read`, async (t) => {
    const opened = await open(t);
    const { backend, registry, setting, catalog, update } = opened;
    registry.set(update, CHANGE);
    await backend.save(0);
    start(opened);
    await backend.read(1);
    const reloading = registry.get(setting) as Result;
    assert.equal(show(reloading), "Success waiting revision 1", "the other read is in flight");

    const confirmed = await opened.confirm();
    assert.equal(confirmed.value?.revision, SAVED.revision, "the confirmed save shows at once");
    assert.equal(
      confirmed.waiting,
      true,
      "a confirmed save must not hide the read that is still in flight",
    );

    backend.answerReads(ANSWER);
    const answered = await until(
      registry,
      setting,
      (value) => value.value?.revision === ANSWER.revision,
    );
    assert.equal(show(answered), "Success revision 3", "the read's answer replaces the saved value");
    assert.deepEqual(answered.value?.enabledTools, [READ.name, WRITE.name, REVIEW.name]);
    await until(
      registry,
      catalog,
      (value) => tools(value)?.join() === [READ.name, WRITE.name, REVIEW.name].join(),
    );
  });

test("a save confirmed with no other read in flight waits for the read it starts", async (t) => {
  const { backend, registry, setting, update, confirm } = await open(t);
  registry.set(update, CHANGE);
  const confirmed = await confirm();
  assert.equal(show(confirmed), "Success waiting revision 2");
  backend.answerReads(ANSWER);
  const answered = await until(
    registry,
    setting,
    (value) => value.value?.revision === ANSWER.revision,
  );
  assert.equal(show(answered), "Success revision 3");
});

test("a read that fails after a save was confirmed during it keeps the saved setting", async (t) => {
  const { backend, registry, setting, update, confirm } = await open(t);
  registry.set(update, CHANGE);
  await backend.save(0);
  returnToPage();
  await backend.read(1);
  await confirm();
  backend.failReads({ _tag: "ToolAvailabilityUnavailable" });
  const failed = await until(registry, setting, (value) => value._tag === "Failure");
  assert.equal(failed.waiting, false, "the failed read is no longer in flight");
  const kept = AsyncResult.value(failed) as { _tag: string; value?: { revision: number } };
  assert.equal(kept.value?.revision, SAVED.revision, "a transport failure keeps the confirmed save");
});
