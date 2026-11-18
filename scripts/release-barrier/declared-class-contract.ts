import type { WorkerBaseline } from "./worker-baselines.ts";
import type * as Workers from "@distilled.cloud/cloudflare/workers";
import type * as Plan from "alchemy/Plan";
import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import { getDurableObjectTagMap } from "alchemy/Cloudflare/Workers";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { canonical, digest, type ModulePart } from "./manifest.ts";
import type { PropChange } from "./prop-diff.ts";
import { versionMetadata } from "./version-request.ts";

export interface ClassTarget {
  accountId: string;
  scriptName: string;
}
/**
 * Callers hold wider values (the captured upload request, a frozen observation). The SDK sends
 * every key its schema doesn't model as a body field, even on GET, and fetch refuses a GET body.
 * `readCurrentDeployment` in cloudflare.ts narrows its baseline read for the same reason.
 */
export const classTarget = (value: ClassTarget) => {
  const { accountId, scriptName } = value;
  if (typeof accountId !== "string" || !accountId || typeof scriptName !== "string" || !scriptName)
    throw new TypeError("Class target requires an account and script name");
  return { accountId, scriptName };
};
export interface ClassObservation extends ClassTarget {
  workerId: string;
  versionId: string;
  /** Absent on an untagged Worker; see `classUntagged`. */
  migrationTag?: string;
  settings: Workers.GetScriptScriptAndVersionSettingResponse;
  previewUrlsEnabled: boolean;
  /** Script settings omit container linkage; an additive upload must carry the active version's unchanged. */
  containers?: readonly { className: string }[];
}
export interface ClassContent {
  mainModule: string;
  files: readonly ModulePart[];
}
export interface ClassProvider {
  read(target: ClassTarget): Promise<ClassObservation>;
  content(target: ClassTarget, versionId: string): Promise<ClassContent>;
  deploy(
    request: Workers.PutScriptRequest,
  ): Promise<{ startupTimeMs: number; migrationTag?: string | null }>;
  stageClone(request: Workers.CreateBetaWorkerVersionRequest): Promise<{ versionId: string }>;
  clone(
    target: ClassTarget,
    versionId: string,
  ): Promise<Workers.GetBetaWorkerVersionResponse | undefined>;
  removeClone(target: ClassTarget, versionId: string): Promise<void>;
}
export interface ClassProgress {
  fqn: string;
  entry: string;
  declaration: string;
  native: { instanceId: string; workerId: string; providerVersion: number; mode?: string };
  baseline: ClassObservation;
  newTag?: string;
  payload: string;
  request: Workers.PutScriptRequest;
  outcome: "planned" | "pending" | "unknown" | "acknowledged" | "ready" | "not-ready";
  phase?: "before-upload" | "before-activation";
  clone: {
    request: Workers.CreateBetaWorkerVersionRequest;
    versionId?: string;
    payload: string;
    status: "pending" | "ready" | "removal-pending" | "removed";
  };
  observed?: ClassObservation;
  startupTimeMs?: number;
}

export const classEntries = (declarations?: {
  changes: readonly ({ action: string } | SqliteClassDeclaration)[];
}) =>
  (declarations?.changes ?? []).filter(
    (entry): entry is SqliteClassDeclaration => entry.action === "add-sqlite-class",
  );
const classTagValues = (tags: readonly string[]) =>
  tags
    .filter((tag) => tag.startsWith("alchemy:migration-tag:"))
    .map((tag) => tag.slice("alchemy:migration-tag:".length));
export const classTag = (tags: readonly string[] = []) => {
  const values = classTagValues(tags);
  return values.length === 1 && values[0] ? values[0] : undefined;
};
/**
 * Alchemy writes `alchemy:migration-tag:` only once a Worker has a tag, and never bumps an absent
 * one, so a Worker it created untagged keeps receiving untagged migrations. Untagged means no such
 * tag at all; one malformed or several tags is neither mode.
 */
export const classUntagged = (tags: readonly string[] = []) => classTagValues(tags).length === 0;
const sorted = (values: readonly unknown[]) => [...values].map(canonical).sort();
type BindingIdentity = {
  type: string;
  name: string;
  className?: string | null;
  namespaceId?: string | null;
  scriptName?: string | null;
};
type LocalBinding = BindingIdentity & { type: "durable_object_namespace"; className: string };
const local = (bindings: readonly BindingIdentity[], script: string) =>
  bindings.filter(
    (binding): binding is LocalBinding =>
      binding.type === "durable_object_namespace" &&
      typeof binding.className === "string" &&
      (!binding.scriptName || binding.scriptName === script),
  );
export const classNamespaces = (value: Pick<ClassObservation, "settings" | "scriptName">) =>
  Object.fromEntries(
    local(value.settings.bindings ?? [], value.scriptName).map((binding) => [
      binding.className!,
      binding.namespaceId,
    ]),
  );

/** Alchemy's native map: every class binding with a namespace id, another script's included. */
const alchemyNamespaces = (value: Pick<ClassObservation, "settings">) =>
  Object.fromEntries(
    (value.settings.bindings ?? []).flatMap((binding: BindingIdentity) =>
      binding.type === "durable_object_namespace" && binding.className && binding.namespaceId
        ? [[binding.className, binding.namespaceId]]
        : [],
    ),
  );

/**
 * The native row holds the class step's local map until the Worker activates, then alchemy's own
 * map, which also carries classes bound from other scripts. Anything else is drift.
 */
export const nativeNamespacesMatch = (
  native: unknown,
  observed: Pick<ClassObservation, "settings" | "scriptName">,
) =>
  native != null &&
  [classNamespaces(observed), alchemyNamespaces(observed)].some(
    (expected) => canonical(native) === canonical(expected),
  );

export function classPlanChanges(node: Plan.Apply, entry: SqliteClassDeclaration): PropChange[] {
  const changes: PropChange[] = [];
  if (node.resource.Type !== entry.type)
    changes.push({ path: "$declaration.type", old: entry.type, new: node.resource.Type });
  if (node.resource.FQN !== entry.fqn)
    changes.push({ path: "$declaration.fqn", old: entry.fqn, new: node.resource.FQN });
  if (!["update", "noop"].includes(node.action))
    changes.push({ path: "$declaration.action", old: "update-or-noop", new: node.action });
  if (node.renamedFrom?.length)
    changes.push({ path: "$declaration.renamedFrom.count", old: 0, new: node.renamedFrom.length });
  if (node.state?.status !== "created" && node.state?.status !== "updated")
    changes.push({
      path: "$declaration.native.status",
      old: "created-or-updated",
      new: node.state?.status ?? null,
    });
  const duplicateClasses = entry.newSqliteClasses.length - new Set(entry.newSqliteClasses).size;
  if (duplicateClasses)
    changes.push({
      path: "$declaration.newSqliteClasses.duplicates",
      old: 0,
      new: duplicateClasses,
    });
  const duplicateBindings =
    entry.addedBindings.length - new Set(entry.addedBindings.map((binding) => binding.name)).size;
  if (duplicateBindings)
    changes.push({ path: "$declaration.addedBindings.duplicates", old: 0, new: duplicateBindings });
  const expected = canonical([...entry.newSqliteClasses].sort());
  const observed = canonical(
    [...new Set(entry.addedBindings.map((binding) => binding.className))].sort(),
  );
  if (expected !== observed)
    changes.push({
      path: "$declaration.addedBindings.classSetHash",
      old: digest(expected),
      new: digest(observed),
    });
  return changes;
}

export const classPlanMatches = (node: Plan.Apply, entry: SqliteClassDeclaration) =>
  classPlanChanges(node, entry).length === 0;

type ClassSettings = Workers.GetScriptScriptAndVersionSettingResponse;

/** The exact declared binding delta, without `location`; anything else added or dropped refuses. */
function classBindingDelta(
  old: ClassSettings,
  metadata: Workers.PutScriptMetadata,
  entry: SqliteClassDeclaration,
  scriptName: string,
) {
  const before = local(old.bindings ?? [], scriptName);
  const after = local(metadata.bindings ?? [], scriptName);
  const expected = entry.addedBindings.map(({ location: _location, ...binding }) => binding);
  const project = (binding: (typeof after)[number]) => ({
    type: binding.type,
    name: binding.name,
    className: binding.className,
  });
  const newBindings = after.filter(
    (binding) => !before.some((previous) => previous.name === binding.name),
  );
  if (
    canonical(sorted(newBindings.map(project))) !== canonical(sorted(expected)) ||
    before.some(
      (binding) => !after.some((next) => canonical(project(binding)) === canonical(project(next))),
    ) ||
    expected.some((binding) =>
      before.some(
        (previous) => previous.name === binding.name || previous.className === binding.className,
      ),
    )
  )
    throw declaredMismatch(
      "declared-class-binding-mismatch",
      entry.fqn,
      { bindings: [...before.map(project), ...expected] },
      { bindings: after.map(project) },
      entry.type,
    );
  return expected;
}

/**
 * Project exactly this declaration's class and tag delta onto the observed settings, so the
 * ordinary settings comparison treats the declared classes as live and still refuses anything else.
 */
export function projectDeclaredClasses(
  previousSettings: ClassSettings,
  metadata: Workers.PutScriptMetadata,
  entry: SqliteClassDeclaration,
  scriptName: string,
): ClassSettings {
  const expected = classBindingDelta(previousSettings, metadata, entry, scriptName);
  const oldMap = getDurableObjectTagMap(previousSettings.tags ?? []);
  const nextMap = getDurableObjectTagMap(metadata.tags ?? []);
  if (
    Object.entries(oldMap).some(([key, value]) => nextMap[key] !== value) ||
    Object.entries(nextMap).some(
      ([key, value]) => !Object.hasOwn(oldMap, key) && !entry.newSqliteClasses.includes(value),
    )
  )
    throw declaredMismatch("declared-class-tags-mismatch", entry.fqn, oldMap, nextMap, entry.type);
  const stripDoTags = (tags: readonly string[] = []) =>
    tags
      .filter(
        (tag) =>
          !tag.startsWith("alchemy:dos:") &&
          !tag.startsWith("alchemy:do:") &&
          !tag.startsWith("alchemy:migration-tag:"),
      )
      .sort();
  if (canonical(stripDoTags(previousSettings.tags ?? [])) !== canonical(stripDoTags(metadata.tags)))
    throw declaredMismatch(
      "declared-class-tags-mismatch",
      entry.fqn,
      { tags: stripDoTags(previousSettings.tags ?? []) },
      { tags: stripDoTags(metadata.tags) },
      entry.type,
    );
  return {
    ...previousSettings,
    bindings: [...(previousSettings.bindings ?? []), ...expected],
    tags: metadata.tags,
  };
}

/**
 * Settings that read-only admissions compare against before the class step runs. Only a candidate
 * that binds a declared class the live Worker lacks is projected; once the classes are live, or for
 * any Worker without a declaration, the observed settings apply unchanged.
 */
export function declaredClassSettings(
  previousSettings: ClassSettings,
  metadata: Workers.PutScriptMetadata,
  entries: readonly SqliteClassDeclaration[],
  fqn: string,
  scriptName: string,
): ClassSettings {
  const entry = entries.find((value) => value.fqn === fqn);
  if (!entry) return previousSettings;
  const live = new Set(local(previousSettings.bindings ?? [], scriptName).map((b) => b.className));
  const adding = local(metadata.bindings ?? [], scriptName).some(
    (binding) => entry.newSqliteClasses.includes(binding.className) && !live.has(binding.className),
  );
  return adding
    ? projectDeclaredClasses(previousSettings, metadata, entry, scriptName)
    : previousSettings;
}

/** This verdict is reused by plan admission and both concrete request checks; it authorizes only the declared additive delta. */
export function classRequestVerdict(
  upload: PreparedWorkerUpload,
  entry: SqliteClassDeclaration,
  proof?: WorkerBaseline,
) {
  const metadata = upload.request.metadata;
  const old = upload.previousSettings;
  const fail = (reason: string, expected: unknown, actual: unknown): never => {
    throw declaredMismatch(reason, entry.fqn, expected, actual, entry.type);
  };
  if (upload.fqn !== entry.fqn || !old || !upload.previous || upload.previous.namespace)
    fail(
      "declared-class-target-mismatch",
      { fqn: entry.fqn, existing: true },
      { fqn: upload.fqn, existing: !!upload.previous },
    );
  // Binding, then migration, then tag refusals: the order a caller sees is unchanged.
  const expected = classBindingDelta(old!, metadata, entry, upload.request.scriptName);
  const migration = metadata.migrations;
  // Either alchemy's tagged step from the Worker's one tag to the next, or its untagged step on a
  // Worker that has never had a tag. Untagged carries no old_tag precondition, so the class and
  // binding checks here and the frozen live baseline are what keep it additive.
  const untagged =
    !!migration &&
    !("steps" in migration) &&
    !migration.oldTag &&
    !migration.newTag &&
    classUntagged(old!.tags ?? []) &&
    classUntagged(metadata.tags);
  const tagged =
    !!migration &&
    !("steps" in migration) &&
    !!migration.oldTag &&
    !!migration.newTag &&
    migration.oldTag !== migration.newTag &&
    classTag(old!.tags ?? []) === migration.oldTag &&
    classTag(metadata.tags) === migration.newTag;
  if (
    !migration ||
    "steps" in migration ||
    (!untagged && !tagged) ||
    canonical(sorted("newSqliteClasses" in migration ? (migration.newSqliteClasses ?? []) : [])) !==
      canonical(sorted(entry.newSqliteClasses)) ||
    Object.entries(migration).some(
      ([key, value]) =>
        !["oldTag", "newTag", "newSqliteClasses"].includes(key) &&
        value != null &&
        (!Array.isArray(value) || value.length),
    )
  )
    fail(
      "declared-class-migration-mismatch",
      { newSqliteClasses: entry.newSqliteClasses, additiveOnly: true },
      { migrations: migration ?? null },
    );
  const projected = projectDeclaredClasses(old!, metadata, entry, upload.request.scriptName);
  // Keep the ordinary settings and metadata guards. Only this exact declaration's class/tag delta is projected as observed.
  versionMetadata(
    {
      ...upload,
      request: { ...upload.request, metadata: { ...metadata, migrations: undefined } },
      previousSettings: projected,
    },
    proof?.versions,
    proof?.baseline,
    proof?.repair,
  );
  return {
    entry: digest(canonical(entry)),
    oldTag: untagged ? undefined : migration!.oldTag!,
    newTag: untagged ? undefined : migration!.newTag!,
    newSqliteClasses: [...entry.newSqliteClasses],
    addedBindings: expected,
  };
}
