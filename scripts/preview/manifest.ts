import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { PreviewIdentity } from "../environment.ts";

export type PreviewManifestPhase =
  | "planned"
  | "deploying"
  | "deployed"
  | "seeded"
  | "destroying"
  | "destroyed";

export type PreviewManifest = PreviewIdentity & {
  readonly version: 1;
  readonly phase: PreviewManifestPhase;
  readonly organizationId?: string;
  readonly poolAppId?: string;
};

const keys = [
  "version",
  "pullRequest",
  "stage",
  "sourceNamespace",
  "databaseName",
  "origin",
  "phase",
  "organizationId",
  "poolAppId",
] as const;

function assertManifest(value: unknown, pullRequest: number): PreviewManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Preview manifest is invalid");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).some((key) => !keys.includes(key as (typeof keys)[number])))
    throw new Error("Preview manifest contains unsupported fields");
  if (
    manifest.version !== 1 || manifest.pullRequest !== pullRequest ||
    manifest.stage !== `test-pr-${pullRequest}` ||
    manifest.sourceNamespace !== `basalt-preview-pr-${pullRequest}-apps` ||
    manifest.databaseName !== `basalt-preview-pr-${pullRequest}` ||
    typeof manifest.origin !== "string" || !/^https:\/\/[^/]+$/.test(manifest.origin) ||
    !["planned", "deploying", "deployed", "seeded", "destroying", "destroyed"].includes(String(manifest.phase))
  ) throw new Error("Preview manifest identity or phase is invalid");
  if (manifest.phase === "seeded" &&
    (typeof manifest.organizationId !== "string" || typeof manifest.poolAppId !== "string"))
    throw new Error("Seeded preview manifest is missing its smoke IDs");
  for (const key of ["organizationId", "poolAppId"] as const) {
    if (manifest[key] !== undefined && (typeof manifest[key] !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(manifest[key])))
      throw new Error("Preview manifest contains an invalid seed ID");
  }
  return manifest as PreviewManifest;
}

export function newPreviewManifest(identity: PreviewIdentity): PreviewManifest {
  return assertManifest({ version: 1, ...identity, phase: "planned" }, identity.pullRequest);
}

export async function readPreviewManifest(path: string, pullRequest: number): Promise<PreviewManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Preview manifest is missing or unreadable");
  }
  return assertManifest(value, pullRequest);
}

/** Replace atomically and keep both the directory and file private on the runner. */
export async function writePreviewManifest(path: string, manifest: PreviewManifest): Promise<void> {
  const value = assertManifest(manifest, manifest.pullRequest);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.pr-${manifest.pullRequest}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await writeFile(temporary, "", { flag: "w", mode: 0o600 }).catch(() => {});
    throw error;
  }
}

export async function updatePreviewManifest(
  path: string,
  pullRequest: number,
  phase: PreviewManifestPhase,
  seed?: { readonly organizationId: string; readonly poolAppId: string },
): Promise<PreviewManifest> {
  const current = await readPreviewManifest(path, pullRequest);
  const next = assertManifest({
    ...current,
    phase,
    ...(seed ?? {}),
  }, pullRequest);
  await writePreviewManifest(path, next);
  return next;
}
