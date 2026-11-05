import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, upstreamCache, withCacheLock } from "./upstream-cache.ts";
import {
  currentProcessOwner,
  installerGroupAlive,
  ownerInSnapshot,
  processSnapshot,
} from "./process-owner.ts";

export const withDependencyStoreLock = <A>(use: () => A | Promise<A>) =>
  withCacheLock(join(upstreamCache(), "collection.lock"), use);

export function atomicStoreJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.pending`;
  writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function record(path: string) {
  const parsed = readJson(path);
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function directories(path: string) {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(path, entry.name));
}

function removeDirectory(path: string) {
  // Package directories are immutable; only this owned tree's directories need write permission to unlink it.
  const writable = (directory: string) => {
    chmodSync(directory, 0o755);
    for (const child of directories(directory)) writable(child);
  };
  if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())
    throw new Error("Refusing to collect a dependency-store link");
  writable(path);
  rmSync(path, { recursive: true });
}

export function rememberDependencyConsumer(root: string, store: string, pending: boolean) {
  root = realpathSync(root);
  const file = join(upstreamCache(), "consumers", `${digest(root)}.json`);
  const previous = record(file);
  const installed = record(join(root, ".basalt-dependencies.json"));
  const stores = new Set([store]);
  if (pending) {
    if (typeof installed?.store === "string") stores.add(installed.store);
    if (Array.isArray(previous?.stores))
      for (const prior of previous.stores) if (typeof prior === "string") stores.add(prior);
  }
  atomicStoreJson(file, { root, stores: [...stores], pending });
}

/** Call only while holding collection.lock, including publication and consumer transitions. */
export function collectDependencyStore() {
  const entries = directories(join(upstreamCache(), "prepared"))
    .flatMap((pin) => directories(pin))
    .filter((entry) => record(join(entry, "store-format.json"))?.version === 3);
  const attempts = entries
    .flatMap((entry) => directories(join(entry, "attempts")))
    .map((path) => ({
      path,
      parent: record(join(path, "parent.json")),
      installer: record(join(path, "installer.json")),
    }));
  const groups = attempts.flatMap(({ installer }) =>
    typeof installer?.group === "number" ? [installer.group] : [],
  );
  const live = processSnapshot(groups);
  if (!live.complete) return;
  const cache = upstreamCache(),
    protectedStores = new Set<string>();
  const consumers = join(cache, "consumers");
  const abandonedConsumers: string[] = [];
  if (existsSync(consumers))
    for (const entry of readdirSync(consumers, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = join(consumers, entry.name),
        consumer = record(file);
      if (typeof consumer?.root !== "string" || !Array.isArray(consumer.stores))
        throw new Error("Cannot validate a dependency consumer reference");
      if (!existsSync(consumer.root)) {
        abandonedConsumers.push(file);
        continue;
      }
      const installed = record(join(consumer.root, ".basalt-dependencies.json"));
      const stores =
        consumer.pending === false && typeof installed?.store === "string"
          ? [installed.store]
          : consumer.stores;
      for (const store of stores) if (typeof store === "string") protectedStores.add(store);
    }
  let abandoned: string[];
  try {
    abandoned = attempts
      .filter(
        ({ parent, installer }) =>
          !ownerInSnapshot(parent, live) && !installerGroupAlive(installer, live),
      )
      .map(({ path }) => path);
  } catch {
    // Unknown ownership must not authorize even a partial collection pass.
    return;
  }
  const retired = entries
    .flatMap((entry) => directories(join(entry, "generations")))
    .filter((generation) => !protectedStores.has(realpathSync(generation)));
  for (const file of abandonedConsumers) rmSync(file);
  for (const path of [...abandoned, ...retired]) removeDirectory(path);
}

export const collectUpstreamDependencies = () => withDependencyStoreLock(collectDependencyStore);

export const createInstallAttempt = (entry: string) =>
  withDependencyStoreLock(() => {
    atomicStoreJson(join(entry, "store-format.json"), { version: 3 });
    const attempt = join(entry, "attempts", randomUUID());
    mkdirSync(attempt, { recursive: true });
    atomicStoreJson(join(attempt, "parent.json"), currentProcessOwner());
    return attempt;
  });

export async function installPrivateAttempt(attempt: string) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./upstream-installer.ts", import.meta.url)), attempt],
    {
      cwd: attempt,
      stdio: "inherit",
      detached: true,
      env: { ...process.env, BASALT_DEPENDENCY_INSTALLER: randomUUID() },
    },
  );
  const result = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (result !== 0) throw new Error(`Bun dependency install failed with exit ${result}`);
  if (installerGroupAlive(record(join(attempt, "installer.json")), processSnapshot([child.pid!])))
    throw new Error("Installer descendants still hold their private attempt");
}

export const abandonInstallAttempt = (attempt: string) =>
  withDependencyStoreLock(() => {
    if (existsSync(attempt)) rmSync(join(attempt, "parent.json"), { force: true });
    collectDependencyStore();
  });
