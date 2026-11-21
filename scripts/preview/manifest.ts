import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { identitySubject, type PreviewIdentity } from "../environment.ts";
import { parsePreviewInventory, type PreviewInventory } from "./inventory.ts";
import { stageNames, toSubject, type StageSubject } from "./subject.ts";

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
  readonly remoteInventory?: PreviewInventory;
};

const keys = [
  "version",
  "pullRequest",
  "rehearsal",
  "stage",
  "sourceNamespace",
  "databaseName",
  "origin",
  "phase",
  "organizationId",
  "poolAppId",
  "remoteInventory",
] as const;

function assertManifest(value: unknown, owner: number | StageSubject): PreviewManifest {
  const subject = toSubject(owner);
  const names = stageNames(subject);
  const field = subject.kind === "pr" ? "pullRequest" : "rehearsal";
  const other = subject.kind === "pr" ? "rehearsal" : "pullRequest";
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Preview manifest is invalid");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).some((key) => !keys.includes(key as (typeof keys)[number])))
    throw new Error("Preview manifest contains unsupported fields");
  if (
    manifest.version !== 1 ||
    manifest[field] !== subject.number ||
    other in manifest ||
    manifest.stage !== names.stage ||
    manifest.sourceNamespace !== names.sourceNamespace ||
    manifest.databaseName !== names.databaseName ||
    typeof manifest.origin !== "string" ||
    !/^https:\/\/[^/]+$/.test(manifest.origin) ||
    !["planned", "deploying", "deployed", "seeded", "destroying", "destroyed"].includes(
      String(manifest.phase),
    )
  )
    throw new Error("Preview manifest identity or phase is invalid");
  if (
    manifest.phase === "seeded" &&
    (typeof manifest.organizationId !== "string" || typeof manifest.poolAppId !== "string")
  )
    throw new Error("Seeded preview manifest is missing its smoke IDs");
  for (const key of ["organizationId", "poolAppId"] as const) {
    if (
      manifest[key] !== undefined &&
      (typeof manifest[key] !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(manifest[key]))
    )
      throw new Error("Preview manifest contains an invalid seed ID");
  }
  const phase = manifest.phase as PreviewManifestPhase;
  const fields = {
    stage: names.stage,
    sourceNamespace: names.sourceNamespace,
    databaseName: names.databaseName,
    origin: manifest.origin,
  };
  const identity: PreviewIdentity =
    subject.kind === "pr"
      ? { pullRequest: subject.number, ...fields }
      : { rehearsal: subject.number, ...fields };
  return {
    version: 1,
    ...identity,
    phase,
    ...(manifest.organizationId === undefined
      ? {}
      : { organizationId: manifest.organizationId as string }),
    ...(manifest.poolAppId === undefined ? {} : { poolAppId: manifest.poolAppId as string }),
    ...(manifest.remoteInventory === undefined
      ? {}
      : { remoteInventory: parsePreviewInventory(manifest.remoteInventory, identity.stage) }),
  };
}

export function newPreviewManifest(identity: PreviewIdentity): PreviewManifest {
  return assertManifest({ version: 1, ...identity, phase: "planned" }, identitySubject(identity));
}

export async function readPreviewManifest(
  path: string,
  owner: number | StageSubject,
): Promise<PreviewManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("Preview manifest is missing or unreadable");
  }
  return assertManifest(value, owner);
}

/** Replace atomically and keep both the directory and file private on the runner. */
export async function writePreviewManifest(path: string, manifest: PreviewManifest): Promise<void> {
  const subject = identitySubject(manifest);
  const value = assertManifest(manifest, subject);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${stageNames(subject).slug}-${randomUUID()}.tmp`);
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
  owner: number | StageSubject,
  phase: PreviewManifestPhase,
  seed?: { readonly organizationId: string; readonly poolAppId: string },
  remoteInventory?: PreviewInventory,
): Promise<PreviewManifest> {
  const current = await readPreviewManifest(path, owner);
  const next = assertManifest(
    {
      ...current,
      phase,
      ...seed,
      ...(remoteInventory === undefined ? {} : { remoteInventory }),
    },
    owner,
  );
  await writePreviewManifest(path, next);
  return next;
}
