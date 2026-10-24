import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deleteEuNamespace } from "../ensure-artifacts.ts";
import {
  previewCleanupEnvironment,
  previewEnvironment,
  previewIdentity,
  type PreviewIdentity,
} from "../environment.ts";
import { manifestPath, previewNumber } from "../release-preview/checkpoint.ts";
import {
  alchemyPreviewStateReader,
  capturePreviewInventory,
  inventoryResourceCount,
  mergePreviewInventories,
  withPreviewProviderInventory,
  type PreviewInventory,
  type PreviewStateReader,
} from "./inventory.ts";
import {
  newPreviewManifest,
  readPreviewManifest,
  updatePreviewManifest,
  writePreviewManifest,
} from "./manifest.ts";
import {
  providerReadbacks,
  capturePreviewProviderInventory,
  verifyPreviewProvidersAbsent,
  type PreviewProviderReadbacks,
} from "./provider-absence.ts";

const rootFromModule = fileURLToPath(new URL("../../", import.meta.url));
const cloudDirectory = join(rootFromModule, ".upstream/apps/hosted/cloud");
const mainConfig = "../../../../alchemy.run.ts";
const cleanupConfig = "../../../../scripts/preview/stack/alchemy.cleanup.ts";
const databaseConfig = "../../../../scripts/preview/stack/alchemy.database.ts";

type StackAction = "deploy" | "destroy";
export interface LifecycleServices {
  readonly stateReader: (environment: NodeJS.ProcessEnv) => PreviewStateReader;
  readonly captureProviders: (identity: PreviewIdentity, inventory: PreviewInventory, environment: NodeJS.ProcessEnv) => Promise<PreviewInventory["providers"]>;
  readonly build: (root: string, identity: PreviewIdentity, source: NodeJS.ProcessEnv) => Promise<void>;
  readonly deploy: (identity: PreviewIdentity, environment: NodeJS.ProcessEnv, seedFile: string) => Promise<void>;
  readonly destroyStack: (stack: "basalt" | "database", identity: PreviewIdentity, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly deleteArtifacts: (namespace: string, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly verifyProviders: (
    identity: PreviewIdentity,
    inventory: PreviewInventory,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries([
    "PATH", "HOME", "TMPDIR", "LANG", "CI", "GITHUB_ACTIONS", "BUN_INSTALL", "NODE_OPTIONS",
  ].flatMap((name) => source[name] === undefined ? [] : [[name, source[name]]])) as NodeJS.ProcessEnv;
}

function runChild(command: string, args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let size = 0;
    let tooMuchOutput = false;
    const discard = (chunk: Buffer) => {
      size += chunk.length;
      if (size > 24 * 1024 * 1024 && !tooMuchOutput) {
        tooMuchOutput = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout.on("data", discard);
    child.stderr.on("data", discard);
    const onInterrupt = () => child.kill("SIGINT");
    const onTerminate = () => child.kill("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    child.once("error", () => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      rejectPromise(new Error("Preview command could not start"));
    });
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      if (tooMuchOutput) return rejectPromise(new Error("Preview command output exceeded its private bound"));
      if (code !== 0) return rejectPromise(new Error("Preview command failed" + (signal ? " with " + signal : " with exit " + code)));
      resolvePromise();
    });
  });
}

async function runAlchemy(
  action: StackAction,
  config: string,
  identity: PreviewIdentity,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await runChild("bun", [
    "exec", "alchemy", "--log-level", "none", action, config,
    "--stage", identity.stage, "--yes", "--no-input",
  ], cloudDirectory, environment);
}

function identityFromManifest(
  value: Awaited<ReturnType<typeof readPreviewManifest>>,
  identity: PreviewIdentity,
): void {
  if (value.pullRequest !== identity.pullRequest || value.stage !== identity.stage ||
    value.sourceNamespace !== identity.sourceNamespace || value.databaseName !== identity.databaseName ||
    value.origin !== identity.origin) throw new Error("Preview manifest does not match the requested PR identity");
}

function seedIds(value: unknown, identity: PreviewIdentity): { organizationId: string; poolAppId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preview seed output is invalid");
  const seed = value as Record<string, unknown>;
  const organization = seed.organization;
  if (seed.version !== 1 || seed.stage !== identity.stage || seed.origin !== identity.origin ||
    typeof organization !== "object" || organization === null || Array.isArray(organization) ||
    typeof (organization as Record<string, unknown>).id !== "string" ||
    typeof (organization as Record<string, unknown>).slug !== "string" ||
    typeof seed.poolAppId !== "string") throw new Error("Preview seed output does not match its stage");
  const organizationId = (organization as Record<string, unknown>).id as string;
  const poolAppId = seed.poolAppId;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(organizationId) || !/^[A-Za-z0-9_-]{1,256}$/.test(poolAppId))
    throw new Error("Preview seed output contains an invalid ID");
  return { organizationId, poolAppId };
}

async function materializePreviewBrand(root: string, identity: PreviewIdentity, action: () => Promise<void>): Promise<void> {
  const path = join(root, "brand.ts");
  const original = await readFile(path, "utf8");
  const metadata = await stat(path);
  const host = new URL(identity.origin).hostname;
  const domain = identity.origin.replace(/^https:\/\/app\.pr-[0-9]+\./, "");
  const hostPattern = /(^  host: )"[^\"]+"(,?$)/m;
  const zonePattern = /(^  zone: )"[^\"]+"(,?$)/m;
  const hostMatches = original.match(new RegExp(hostPattern.source, "gm")) ?? [];
  const zoneMatches = original.match(new RegExp(zonePattern.source, "gm")) ?? [];
  if (hostMatches.length !== 1 || zoneMatches.length !== 1)
    throw new Error("The preview brand build seam changed");
  const changed = original
    .replace(hostPattern, (_match, prefix: string, suffix: string) => prefix + JSON.stringify(host) + suffix)
    .replace(zonePattern, (_match, prefix: string, suffix: string) => prefix + JSON.stringify(domain) + suffix);
  if (changed === original) throw new Error("The preview brand build seam did not change");
  await writeFile(path, changed, { mode: metadata.mode & 0o777 });
  try {
    await action();
  } finally {
    const current = await readFile(path, "utf8");
    if (current !== changed) throw new Error("Preview brand source changed during the isolated build; restore it before retrying");
    await writeFile(path, original, { mode: metadata.mode & 0o777 });
    await chmod(path, metadata.mode & 0o777);
  }
}

function liveServices(source: NodeJS.ProcessEnv): LifecycleServices {
  return {
    stateReader: (environment) => alchemyPreviewStateReader({ environment }),
    captureProviders: (identity, inventory, environment) =>
      capturePreviewProviderInventory(identity, inventory, providerReadbacks(environment)),
    build: async (root) => runChild("npm", ["run", "build"], root, safeEnvironment(source)),
    deploy: async (identity, environment) => {
      // The per-PR PlanetScale parent must exist before the application declares branches in it.
      await runAlchemy("deploy", databaseConfig, identity, environment);
      await runAlchemy("deploy", mainConfig, identity, environment);
    },
    destroyStack: async (stack, identity, environment) => {
      await runAlchemy("destroy", stack === "basalt" ? cleanupConfig : databaseConfig, identity, environment);
    },
    deleteArtifacts: async (namespace, environment) => {
      const account = environment.CLOUDFLARE_ACCOUNT_ID;
      const token = environment.CLOUDFLARE_API_TOKEN;
      if (!account || !token) throw new Error("Preview cleanup credentials are missing");
      const { cloudflareArtifactsApi } = await import("../ensure-artifacts.ts");
      await deleteEuNamespace(cloudflareArtifactsApi(account, token), namespace);
    },
    verifyProviders: (identity, inventory, environment) =>
      verifyPreviewProvidersAbsent(identity, inventory, providerReadbacks(environment)),
  };
}

export async function planPreview(root: string, pullRequest: number, source: NodeJS.ProcessEnv): Promise<void> {
  const identity = previewIdentity(pullRequest, source);
  await writePreviewManifest(manifestPath(root, pullRequest), newPreviewManifest(identity));
}

export async function deployPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  if (source.GITHUB_ACTIONS !== "true") throw new Error("Release previews run only in GitHub Actions");
  if (source.PREVIEW_MANIFEST_CHECKPOINTED !== "1")
    throw new Error("The encrypted cleanup checkpoint must be uploaded before deployment");
  const config = previewEnvironment(pullRequest, source);
  const path = manifestPath(root, pullRequest);
  const manifest = await readPreviewManifest(path, pullRequest);
  identityFromManifest(manifest, config);
  if (manifest.phase !== "planned") throw new Error("Preview deployment needs a fresh planned checkpoint");
  const initial = await capturePreviewInventory(config, services.stateReader(config.deploy));
  if (inventoryResourceCount(initial) !== 0)
    throw new Error("Preview stage has existing remote state; recover it before deploying again");

  const seedFile = join(root, ".local", "previews", "seed-pr-" + pullRequest + ".json");
  await mkdir(dirname(seedFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(seedFile), 0o700);
  const environment = {
    ...config.deploy,
    ...config.seed,
    PREVIEW_AUTH_SEED_OUTPUT: seedFile,
  };
  let deploying: Awaited<ReturnType<typeof updatePreviewManifest>> | undefined;
  await materializePreviewBrand(root, config, async () => {
    await services.build(root, config, source);
    deploying = await updatePreviewManifest(path, pullRequest, "deploying");
    await services.deploy(config, environment, seedFile);
  });
  const seed = seedIds(JSON.parse(await readFile(seedFile, "utf8")), config);
  await updatePreviewManifest(path, pullRequest, "seeded", seed, deploying?.remoteInventory);
}

export async function destroyPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  const config = previewCleanupEnvironment(pullRequest, source);
  const path = manifestPath(root, pullRequest);
  const manifest = await readPreviewManifest(path, pullRequest);
  identityFromManifest(manifest, config);
  const current = await capturePreviewInventory(config, services.stateReader(config.providers));
  const providerInventory = await services.captureProviders(config, current, config.providers);
  const captured = withPreviewProviderInventory(current, providerInventory, config.stage);
  const inventory = mergePreviewInventories(manifest.remoteInventory, captured, config.stage);
  await updatePreviewManifest(path, pullRequest, "destroying", undefined, inventory);

  const failures: unknown[] = [];
  for (const [stack, action] of [
    ["basalt", () => services.destroyStack("basalt", config, config.providers)],
    ["database", () => services.destroyStack("database", config, config.providers)],
    ["artifacts", () => services.deleteArtifacts(config.sourceNamespace, config.providers)],
  ] as const) {
    try { await action(); }
    catch { failures.push(new Error("Preview " + stack + " cleanup failed")); }
  }
  if (failures.length) throw new AggregateError(failures, "Preview cleanup did not finish");
  await updatePreviewManifest(path, pullRequest, "destroyed", undefined, inventory);
}

export async function verifyPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  const config = previewCleanupEnvironment(pullRequest, source);
  const path = manifestPath(root, pullRequest);
  const manifest = await readPreviewManifest(path, pullRequest);
  identityFromManifest(manifest, config);
  const inventory = manifest.remoteInventory;
  if (!inventory) throw new Error("No pre-destroy remote inventory was captured");

  const remaining = await capturePreviewInventory(config, services.stateReader(config.providers));
  if (inventoryResourceCount(remaining) !== 0) throw new Error("Preview Alchemy stage state is still present");
  await services.verifyProviders(config, inventory, config.providers);
  if (inventoryResourceCount(inventory) === 0)
    throw new Error("Preview was not backed by a non-empty pre-destroy remote inventory");

  await rm(path, { force: true });
  await rm(join(root, ".local", "previews", "seed-pr-" + pullRequest + ".json"), { force: true });
}

async function main(): Promise<void> {
  const [mode, rawNumber] = process.argv.slice(2);
  const number = previewNumber(rawNumber);
  const root = process.cwd();
  if (mode === "plan") await planPreview(root, number, process.env);
  else if (mode === "deploy") await deployPreview(root, number, process.env);
  else if (mode === "destroy") await destroyPreview(root, number, process.env);
  else if (mode === "verify") await verifyPreview(root, number, process.env);
  else throw new Error("Usage: lifecycle.ts plan|deploy|destroy|verify PR_NUMBER");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
    console.log("Preview lifecycle step passed");
  } catch {
    console.error("Preview lifecycle step failed; remote provider absence is not established");
    process.exitCode = 1;
  }
}
