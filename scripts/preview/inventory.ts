import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { PreviewIdentity } from "../environment.ts";

export const previewStacks = ["basalt", "basalt-preview-database"] as const;
export type PreviewStack = (typeof previewStacks)[number];

export type PreviewStateEntry = { readonly path: string; readonly value: unknown };
export type PreviewContainerReference = { readonly applicationId: string; readonly applicationName: string };
export type PreviewDomainReference = { readonly id: string | null; readonly hostname: string; readonly service: string };
export type PreviewProviderInventory = {
  readonly complete: boolean;
  readonly containers: readonly PreviewContainerReference[];
  readonly domains: readonly PreviewDomainReference[];
};
export type PreviewInventory = {
  readonly version: 1;
  readonly capturedAt: string;
  readonly stacks: Readonly<Record<PreviewStack, readonly PreviewStateEntry[]>>;
  readonly providers: PreviewProviderInventory;
};

export interface PreviewStateReader {
  read(stage: string): Promise<Readonly<Record<PreviewStack, readonly PreviewStateEntry[]>>>;
}

type CommandResult = { readonly status: number | null; readonly stdout: string; readonly error?: Error | undefined };
export type StateCommand = (args: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => CommandResult;

const root = fileURLToPath(new URL("../../", import.meta.url));
const cloudDirectory = join(root, ".upstream/apps/hosted/cloud");
const stateConfig = "../../../../scripts/preview/stack/alchemy.cleanup.ts";

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Preview state response is malformed");
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).sort().join("\0") !== [...expected].sort().join("\0"))
    throw new Error("Preview state response has unexpected fields");
}

export function parsePreviewInventory(value: unknown, stage: string): PreviewInventory {
  const inventory = assertRecord(value);
  assertExactKeys(inventory, ["version", "capturedAt", "stacks", "providers"]);
  if (inventory.version !== 1 || typeof inventory.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(inventory.capturedAt)) ||
    new Date(inventory.capturedAt).toISOString() !== inventory.capturedAt) {
    throw new Error("Preview remote inventory is invalid");
  }
  const stacks = assertRecord(inventory.stacks);
  assertExactKeys(stacks, previewStacks);
  const parsed = {} as Record<PreviewStack, readonly PreviewStateEntry[]>;
  for (const stack of previewStacks) {
    const values = stacks[stack];
    if (!Array.isArray(values)) throw new Error("Preview remote inventory is invalid");
    const seen = new Set<string>();
    parsed[stack] = values.map((entry) => {
      const row = assertRecord(entry);
      assertExactKeys(row, ["path", "value"]);
      if (typeof row.path !== "string" || !row.path.startsWith(`${stack}/${stage}/`))
        throw new Error("Preview remote inventory contains an invalid resource path");
      const fingerprint = `${row.path}\0${JSON.stringify(row.value)}`;
      if (seen.has(fingerprint)) throw new Error("Preview remote inventory contains a duplicate readback");
      seen.add(fingerprint);
      return { path: row.path, value: row.value };
    }).sort((left, right) => left.path.localeCompare(right.path, "en") ||
      JSON.stringify(left.value).localeCompare(JSON.stringify(right.value), "en"));
  }
  const providers = assertRecord(inventory.providers);
  assertExactKeys(providers, ["complete", "containers", "domains"]);
  if (typeof providers.complete !== "boolean" || !Array.isArray(providers.containers) || !Array.isArray(providers.domains))
    throw new Error("Preview provider inventory is invalid");
  const containers = providers.containers.map((item) => {
    const row = assertRecord(item);
    assertExactKeys(row, ["applicationId", "applicationName"]);
    if (typeof row.applicationId !== "string" || !row.applicationId ||
      typeof row.applicationName !== "string" || !row.applicationName)
      throw new Error("Preview container readback is invalid");
    return { applicationId: row.applicationId, applicationName: row.applicationName };
  });
  const domains = providers.domains.map((item) => {
    const row = assertRecord(item);
    assertExactKeys(row, ["id", "hostname", "service"]);
    if ((row.id !== null && (typeof row.id !== "string" || !row.id)) ||
      typeof row.hostname !== "string" || !row.hostname ||
      typeof row.service !== "string" || !row.service)
      throw new Error("Preview domain readback is invalid");
    return { id: row.id as string | null, hostname: row.hostname, service: row.service };
  });
  const unique = <T>(values: readonly T[], key: (value: T) => string, label: string): T[] => {
    const seen = new Set<string>();
    for (const value of values) {
      const id = key(value);
      if (seen.has(id)) throw new Error("Preview provider inventory contains duplicate " + label);
      seen.add(id);
    }
    return [...values];
  };
  return {
    version: 1,
    capturedAt: inventory.capturedAt,
    stacks: parsed,
    providers: {
      complete: providers.complete,
      containers: unique(containers, (item) => item.applicationId + "\0" + item.applicationName, "container applications"),
      domains: unique(domains, (item) => (item.id ?? "") + "\0" + item.hostname + "\0" + item.service, "domains"),
    },
  };
}

function defaultStateCommand(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): CommandResult {
  const result = spawnSync("bun", ["exec", "alchemy", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", error: result.error };
}

function runStateCommand(
  command: StateCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): string {
  const result = command(args, cloudDirectory, env);
  if (result.error || result.status !== 0) throw new Error("Authenticated Alchemy remote state read failed");
  return result.stdout;
}

function parsePaths(stdout: string): string[] {
  const paths = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const path of paths) {
    if (!/^[^/\s]+\/[^/\s]+\/.+$/.test(path)) throw new Error("Alchemy returned a malformed remote state path");
  }
  return paths;
}

function parseStageValues(stdout: string, stack: PreviewStack, stage: string, paths: readonly string[]): PreviewStateEntry[] {
  let decoded: unknown;
  try { decoded = JSON.parse(stdout); } catch { throw new Error("Alchemy returned malformed remote resource state"); }
  const prefix = `${stack}/${stage}/`;
  if (paths.length === 1) {
    if (decoded === null && !paths[0]!.endsWith("/output"))
      throw new Error("Alchemy listed a preview resource without a readable state record");
    return [{ path: paths[0]!, value: decoded }];
  }
  const values = assertRecord(decoded);
  assertExactKeys(values, paths);
  return paths.map((path) => {
    if (!path.startsWith(prefix)) throw new Error("Alchemy returned state outside the requested preview stage");
    const value = values[path];
    if ((value === null && !path.endsWith("/output")) || value === undefined)
      throw new Error("Alchemy listed a preview resource without a readable state record");
    return { path, value };
  });
}

/** Reads exact PR stage records from the configured Cloudflare state backend. */
export function alchemyPreviewStateReader(options: {
  readonly command?: StateCommand;
  readonly environment?: NodeJS.ProcessEnv;
} = {}): PreviewStateReader {
  const command = options.command ?? defaultStateCommand;
  const source = options.environment ?? process.env;
  return {
    async read(stage) {
      if (!/^test-pr-[1-9][0-9]*$/.test(stage)) throw new Error("Remote state reads are restricted to PR stages");
      const env = { ...source, ALCHEMY_STAGE: stage, CI: "true" };
      const listed = runStateCommand(command, [
        "--log-level", "none", "state", "list", "--recursive", "--config", stateConfig,
        "--backend", "configured", "--no-input",
      ], env);
      const allPaths = parsePaths(listed);
      const stacks = {} as Record<PreviewStack, PreviewStateEntry[]>;
      for (const stack of previewStacks) {
        const prefix = `${stack}/${stage}/`;
        const paths = allPaths.filter((path) => path.startsWith(prefix)).sort((a, b) => a.localeCompare(b, "en"));
        if (paths.length === 0) {
          stacks[stack] = [];
          continue;
        }
        const stdout = runStateCommand(command, [
          "--log-level", "none", "state", "read", `${stack}/${stage}`, "--recursive", "--config", stateConfig,
          "--backend", "configured", "--no-input",
        ], env);
        stacks[stack] = parseStageValues(stdout, stack, stage, paths);
      }
      return stacks;
    },
  };
}

/** Snapshot and validate both exact stage inventories before any delete begins. */
export async function capturePreviewInventory(
  identity: Pick<PreviewIdentity, "stage">,
  reader: PreviewStateReader = alchemyPreviewStateReader(),
  capturedAt = new Date().toISOString(),
): Promise<PreviewInventory> {
  const stacks = await reader.read(identity.stage);
  return parsePreviewInventory({
    version: 1,
    capturedAt,
    stacks,
    providers: { complete: false, containers: [], domains: [] },
  }, identity.stage);
}

export function inventoryResourceCount(inventory: PreviewInventory): number {
  return previewStacks.reduce((count, stack) => count + inventory.stacks[stack].filter((entry) => !entry.path.endsWith("/output")).length, 0);
}

/** Keep earlier physical identities when a failed cleanup is retried from newer stage state. */
export function mergePreviewInventories(
  previous: PreviewInventory | undefined,
  current: PreviewInventory,
  stage: string,
): PreviewInventory {
  if (!previous) return parsePreviewInventory(current, stage);
  const prior = parsePreviewInventory(previous, stage);
  const next = parsePreviewInventory(current, stage);
  const stacks = {} as Record<PreviewStack, PreviewStateEntry[]>;
  for (const stack of previewStacks) {
    const rows = new Map<string, PreviewStateEntry>();
    for (const entry of [...prior.stacks[stack], ...next.stacks[stack]]) {
      const fingerprint = `${entry.path}\0${JSON.stringify(entry.value)}`;
      rows.set(fingerprint, entry);
    }
    stacks[stack] = [...rows.values()];
  }
  const containers = new Map<string, PreviewContainerReference>();
  for (const item of [...prior.providers.containers, ...next.providers.containers])
    containers.set(item.applicationId + "\0" + item.applicationName, item);
  const domains = new Map<string, PreviewDomainReference>();
  for (const item of [...prior.providers.domains, ...next.providers.domains])
    domains.set((item.id ?? "") + "\0" + item.hostname + "\0" + item.service, item);
  return parsePreviewInventory({
    version: 1,
    capturedAt: next.capturedAt,
    stacks,
    providers: {
      complete: prior.providers.complete || next.providers.complete,
      containers: [...containers.values()],
      domains: [...domains.values()],
    },
  }, stage);
}

export function withPreviewProviderInventory(
  inventory: PreviewInventory,
  providers: PreviewProviderInventory,
  stage: string,
): PreviewInventory {
  return parsePreviewInventory({ ...inventory, providers }, stage);
}
