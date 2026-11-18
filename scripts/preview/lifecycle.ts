import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deleteEuNamespace } from "../ensure-artifacts.ts";
import {
  identitySubject,
  stageCleanupEnvironment,
  stageEnvironment,
  stageIdentity,
  type PreviewEnvironment,
  type PreviewIdentity,
} from "../environment.ts";
import { manifestPath } from "../release-preview/checkpoint.ts";
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
  type PreviewManifest,
  readPreviewManifest,
  updatePreviewManifest,
  writePreviewManifest,
} from "./manifest.ts";
import {
  providerReadbacks,
  capturePreviewProviderInventory,
  verifyPreviewProvidersAbsent,
} from "./provider-absence.ts";
import {
  parseSubjectArgument,
  pullRequestSubject,
  stageNames,
  type StageSubject,
} from "./subject.ts";

const rootFromModule = fileURLToPath(new URL("../../", import.meta.url));
const cloudDirectory = join(rootFromModule, ".upstream/apps/hosted/cloud");
const mainConfig = "../../../../alchemy.run.ts";
const cleanupConfig = "../../../../scripts/preview/stack/alchemy.cleanup.ts";
const databaseConfig = "../../../../scripts/preview/stack/alchemy.database.ts";
const fixtureConfig = "../../../../scripts/preview/stack/alchemy.rehearsal-fixture.ts";

type StackAction = "deploy" | "destroy";
export interface LifecycleServices {
  readonly stateReader: (environment: NodeJS.ProcessEnv) => PreviewStateReader;
  readonly captureProviders: (
    identity: PreviewIdentity,
    inventory: PreviewInventory,
    environment: NodeJS.ProcessEnv,
  ) => Promise<PreviewInventory["providers"]>;
  readonly build: (
    root: string,
    identity: PreviewIdentity,
    source: NodeJS.ProcessEnv,
  ) => Promise<void>;
  readonly deploy: (
    identity: PreviewIdentity,
    environment: NodeJS.ProcessEnv,
    seedFile: string,
  ) => Promise<void>;
  readonly destroyStack: (
    stack: "basalt" | "database" | "fixture",
    identity: PreviewIdentity,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void>;
  readonly deleteArtifacts: (namespace: string, environment: NodeJS.ProcessEnv) => Promise<void>;
  readonly verifyProviders: (
    identity: PreviewIdentity,
    inventory: PreviewInventory,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void>;
  /** A rehearsal's release barrier keeps outputs outside the stage's own stacks. */
  readonly stageOutputs: (
    mode: "delete" | "verify",
    identity: PreviewIdentity,
    environment: NodeJS.ProcessEnv,
  ) => Promise<void>;
}

function safeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "CI",
      "GITHUB_ACTIONS",
      "BUN_INSTALL",
      "NODE_OPTIONS",
    ].flatMap((name) => (source[name] === undefined ? [] : [[name, source[name]]])),
  ) as NodeJS.ProcessEnv;
}

function runChild(
  command: string,
  args: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      if (tooMuchOutput)
        return rejectPromise(new Error("Preview command output exceeded its private bound"));
      if (code !== 0)
        return rejectPromise(
          new Error("Preview command failed" + (signal ? " with " + signal : " with exit " + code)),
        );
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
  await runChild(
    "bun",
    [
      "exec",
      "alchemy",
      "--log-level",
      "none",
      action,
      config,
      "--stage",
      identity.stage,
      "--yes",
      "--no-input",
    ],
    cloudDirectory,
    environment,
  );
}

function identityFromManifest(
  value: Awaited<ReturnType<typeof readPreviewManifest>>,
  identity: PreviewIdentity,
): void {
  if (
    value.pullRequest !== identity.pullRequest ||
    value.rehearsal !== identity.rehearsal ||
    value.stage !== identity.stage ||
    value.sourceNamespace !== identity.sourceNamespace ||
    value.databaseName !== identity.databaseName ||
    value.origin !== identity.origin
  )
    throw new Error("Preview manifest does not match the requested stage identity");
}

function seedIds(
  value: unknown,
  identity: PreviewIdentity,
): { organizationId: string; poolAppId: string } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Preview seed output is invalid");
  const seed = value as Record<string, unknown>;
  const organization = seed.organization;
  if (
    seed.version !== 1 ||
    seed.stage !== identity.stage ||
    seed.origin !== identity.origin ||
    typeof organization !== "object" ||
    organization === null ||
    Array.isArray(organization) ||
    typeof (organization as Record<string, unknown>).id !== "string" ||
    typeof (organization as Record<string, unknown>).slug !== "string" ||
    typeof seed.poolAppId !== "string"
  )
    throw new Error("Preview seed output does not match its stage");
  const organizationId = (organization as Record<string, unknown>).id as string;
  const poolAppId = seed.poolAppId;
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(organizationId) || !/^[A-Za-z0-9_-]{1,256}$/.test(poolAppId))
    throw new Error("Preview seed output contains an invalid ID");
  return { organizationId, poolAppId };
}

async function materializePreviewBrand(
  root: string,
  identity: PreviewIdentity,
  action: () => Promise<void>,
): Promise<void> {
  const path = join(root, "brand.ts");
  const original = await readFile(path, "utf8");
  const metadata = await stat(path);
  const host = new URL(identity.origin).hostname;
  const hostPrefix = `app.${stageNames(identitySubject(identity)).slug}.`;
  const domain = host.startsWith(hostPrefix) ? host.slice(hostPrefix.length) : host;
  const hostPattern = /(^  host: )"[^"]+"(,?$)/m;
  const zonePattern = /(^  zone: )"[^"]+"(,?$)/m;
  const hostMatches = original.match(new RegExp(hostPattern.source, "gm")) ?? [];
  const zoneMatches = original.match(new RegExp(zonePattern.source, "gm")) ?? [];
  if (hostMatches.length !== 1 || zoneMatches.length !== 1)
    throw new Error("The preview brand build seam changed");
  const changed = original
    .replace(
      hostPattern,
      (_match, prefix: string, suffix: string) => prefix + JSON.stringify(host) + suffix,
    )
    .replace(
      zonePattern,
      (_match, prefix: string, suffix: string) => prefix + JSON.stringify(domain) + suffix,
    );
  if (changed === original) throw new Error("The preview brand build seam did not change");
  await writeFile(path, changed, { mode: metadata.mode & 0o777 });
  let failed = false;
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failed = true;
    failure = error;
  }
  // A changed seam is reported instead of the build's own failure and is left for review.
  const current = await readFile(path, "utf8");
  if (current !== changed)
    throw new Error(
      "Preview brand source changed during the isolated build; restore it before retrying",
    );
  await writeFile(path, original, { mode: metadata.mode & 0o777 });
  await chmod(path, metadata.mode & 0o777);
  if (failed) throw failure;
}

function liveServices(source: NodeJS.ProcessEnv): LifecycleServices {
  return {
    stateReader: (environment) => alchemyPreviewStateReader({ environment }),
    captureProviders: (identity, inventory, environment) =>
      capturePreviewProviderInventory(identity, inventory, providerReadbacks(environment)),
    build: async (root) => runChild("npm", ["run", "build"], root, safeEnvironment(source)),
    deploy: async (identity, environment) => {
      // The per-stage PlanetScale parent must exist before the application declares branches in it.
      await runAlchemy("deploy", databaseConfig, identity, environment);
      await runAlchemy("deploy", mainConfig, identity, environment);
    },
    destroyStack: async (stack, identity, environment) => {
      await runAlchemy(
        "destroy",
        stack === "basalt" ? cleanupConfig : stack === "fixture" ? fixtureConfig : databaseConfig,
        identity,
        environment,
      );
    },
    deleteArtifacts: async (namespace, environment) => {
      const account = environment.CLOUDFLARE_ACCOUNT_ID;
      const token = environment.CLOUDFLARE_API_TOKEN;
      if (!account || !token) throw new Error("Preview cleanup credentials are missing");
      const { cloudflareArtifactsApi, stageNamespaces } = await import("../ensure-artifacts.ts");
      const api = cloudflareArtifactsApi(account, token);
      for (const name of stageNamespaces(namespace)) await deleteEuNamespace(api, name);
    },
    verifyProviders: (identity, inventory, environment) =>
      verifyPreviewProvidersAbsent(identity, inventory, providerReadbacks(environment)),
    stageOutputs: (mode, identity, environment) =>
      runChild(
        "bun",
        [join(rootFromModule, "scripts/preview/stage-outputs.ts"), mode, identity.stage],
        rootFromModule,
        { ...environment, ALCHEMY_STAGE: identity.stage },
      ),
  };
}

/** Write the fresh planned checkpoint a stage needs before anything is deployed. */
export async function planStage(
  root: string,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
): Promise<PreviewManifest> {
  const manifest = newPreviewManifest(stageIdentity(subject, source));
  await writePreviewManifest(manifestPath(root, subject), manifest);
  return manifest;
}

export async function planPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
): Promise<void> {
  await planStage(root, pullRequestSubject(pullRequest), source);
}

async function plannedDeployment(
  root: string,
  subject: StageSubject,
  config: PreviewEnvironment,
  services: LifecycleServices,
): Promise<string> {
  const path = manifestPath(root, subject);
  const manifest = await readPreviewManifest(path, subject);
  identityFromManifest(manifest, config);
  if (manifest.phase !== "planned")
    throw new Error("Preview deployment needs a fresh planned checkpoint");
  const initial = await capturePreviewInventory(config, services.stateReader(config.deploy));
  if (inventoryResourceCount(initial) !== 0)
    throw new Error("Preview stage has existing remote state; recover it before deploying again");
  return path;
}

export async function deployPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  await deployStage(root, pullRequestSubject(pullRequest), source, services);
}

/**
 * Deploy the whole stage the ordinary way and seed its sign-in. For a rehearsal this is the
 * previous candidate's stack, the legacy root its releases then run against.
 */
export async function deployStage(
  root: string,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  if (source.GITHUB_ACTIONS !== "true")
    throw new Error("Release previews run only in GitHub Actions");
  if (source.PREVIEW_MANIFEST_CHECKPOINTED !== "1")
    throw new Error("The encrypted cleanup checkpoint must be uploaded before deployment");
  const config = stageEnvironment(subject, source);
  const path = await plannedDeployment(root, subject, config, services);

  const seedFile = join(root, ".local", "previews", "seed-" + stageNames(subject).slug + ".json");
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
    deploying = await updatePreviewManifest(path, subject, "deploying");
    await services.deploy(config, environment, seedFile);
  });
  const seed = seedIds(JSON.parse(await readFile(seedFile, "utf8")), config);
  await updatePreviewManifest(path, subject, "seeded", seed, deploying?.remoteInventory);
}

/**
 * Build the checkout as the stage's own brand and run `action` while that brand is in place. A
 * rehearsal's releases bundle Workers at deploy time, so they must not see the production host.
 */
export async function withStageBuild(
  root: string,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  action: () => Promise<void>,
  services = liveServices(source),
  { build = true }: { build?: boolean } = {},
): Promise<void> {
  const config = stageEnvironment(subject, source);
  await materializePreviewBrand(root, config, async () => {
    if (build) await services.build(root, config, source);
    await action();
  });
}

/**
 * Run the rehearsal's one-shot seed fixture, then destroy its stack and role whatever happened.
 * Its stack is in the stage inventory, so a cancelled run's cleanup removes it as well.
 */
export async function applyRehearsalFixture(
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  input: { organization: string; pools: readonly string[] },
): Promise<void> {
  if (subject.kind !== "rehearsal") throw new Error("Only a rehearsal stage takes the seed fixture");
  const config = stageCleanupEnvironment(subject, source);
  let failure: unknown;
  try {
    await runAlchemy("deploy", fixtureConfig, config, {
      ...config.providers,
      REHEARSAL_ORGANIZATION: input.organization,
      REHEARSAL_UNREGISTERED_POOLS: input.pools.join(","),
    });
  } catch (error) {
    failure = error;
  }
  await runAlchemy("destroy", fixtureConfig, config, config.providers);
  if (failure) throw failure;
}

export async function destroyStage(
  root: string,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  const config = stageCleanupEnvironment(subject, source);
  const path = manifestPath(root, subject);
  const manifest = await readPreviewManifest(path, subject);
  identityFromManifest(manifest, config);
  const current = await capturePreviewInventory(config, services.stateReader(config.providers));
  const providerInventory = await services.captureProviders(config, current, config.providers);
  const captured = withPreviewProviderInventory(current, providerInventory, config.stage);
  const inventory = mergePreviewInventories(manifest.remoteInventory, captured, config.stage);
  await updatePreviewManifest(path, subject, "destroying", undefined, inventory);

  const failures: unknown[] = [];
  for (const [stack, action] of [
    ...(subject.kind === "rehearsal"
      ? ([["fixture", () => services.destroyStack("fixture", config, config.providers)]] as const)
      : []),
    ["basalt", () => services.destroyStack("basalt", config, config.providers)],
    ["database", () => services.destroyStack("database", config, config.providers)],
    ["artifacts", () => services.deleteArtifacts(config.sourceNamespace, config.providers)],
    ...(subject.kind === "rehearsal"
      ? ([["outputs", () => services.stageOutputs("delete", config, config.providers)]] as const)
      : []),
  ] as const) {
    try {
      await action();
    } catch {
      failures.push(new Error("Preview " + stack + " cleanup failed"));
    }
  }
  if (failures.length) throw new AggregateError(failures, "Preview cleanup did not finish");
  await updatePreviewManifest(path, subject, "destroyed", undefined, inventory);
}

export async function destroyPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  await destroyStage(root, pullRequestSubject(pullRequest), source, services);
}

export async function verifyStageAbsent(
  root: string,
  subject: StageSubject,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  const config = stageCleanupEnvironment(subject, source);
  const path = manifestPath(root, subject);
  const manifest = await readPreviewManifest(path, subject);
  identityFromManifest(manifest, config);
  const inventory = manifest.remoteInventory;
  if (!inventory) throw new Error("No pre-destroy remote inventory was captured");

  const remaining = await capturePreviewInventory(config, services.stateReader(config.providers));
  if (inventoryResourceCount(remaining) !== 0)
    throw new Error("Preview Alchemy stage state is still present");
  await services.verifyProviders(config, inventory, config.providers);
  if (subject.kind === "rehearsal") await services.stageOutputs("verify", config, config.providers);
  if (inventoryResourceCount(inventory) === 0)
    throw new Error("Preview was not backed by a non-empty pre-destroy remote inventory");

  await rm(path, { force: true });
  await rm(join(root, ".local", "previews", "seed-" + stageNames(subject).slug + ".json"), {
    force: true,
  });
}

export async function verifyPreview(
  root: string,
  pullRequest: number,
  source: NodeJS.ProcessEnv,
  services = liveServices(source),
): Promise<void> {
  await verifyStageAbsent(root, pullRequestSubject(pullRequest), source, services);
}

async function main(): Promise<void> {
  const [mode, rawSubject] = process.argv.slice(2);
  const subject = parseSubjectArgument(rawSubject);
  const root = process.cwd();
  if (mode === "plan") await planStage(root, subject, process.env);
  else if (mode === "deploy") await deployStage(root, subject, process.env);
  else if (mode === "destroy") await destroyStage(root, subject, process.env);
  else if (mode === "verify") await verifyStageAbsent(root, subject, process.env);
  else
    throw new Error(
      "Usage: lifecycle.ts plan|deploy|destroy|verify PR_NUMBER|rehearsal-N",
    );
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
