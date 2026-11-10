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
export interface ClassObservation extends ClassTarget {
  workerId: string;
  versionId: string;
  migrationTag: string;
  settings: Workers.GetScriptScriptAndVersionSettingResponse;
  previewUrlsEnabled: boolean;
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
  newTag: string;
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
export const classTag = (tags: readonly string[] = []) => {
  const values = tags
    .filter((tag) => tag.startsWith("alchemy:migration-tag:"))
    .map((tag) => tag.slice("alchemy:migration-tag:".length));
  return values.length === 1 && values[0] ? values[0] : undefined;
};
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
  const before = local(old!.bindings ?? [], upload.request.scriptName);
  const after = local(metadata.bindings ?? [], upload.request.scriptName);
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
    fail(
      "declared-class-binding-mismatch",
      { bindings: [...before.map(project), ...expected] },
      { bindings: after.map(project) },
    );
  const migration = metadata.migrations;
  if (
    !migration ||
    "steps" in migration ||
    !migration.oldTag ||
    !migration.newTag ||
    migration.oldTag === migration.newTag ||
    classTag(old!.tags ?? []) !== migration.oldTag ||
    classTag(metadata.tags) !== migration.newTag ||
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
  const oldMap = getDurableObjectTagMap(old!.tags ?? []);
  const nextMap = getDurableObjectTagMap(metadata.tags ?? []);
  if (
    Object.entries(oldMap).some(([key, value]) => nextMap[key] !== value) ||
    Object.entries(nextMap).some(
      ([key, value]) => !Object.hasOwn(oldMap, key) && !entry.newSqliteClasses.includes(value),
    )
  )
    fail("declared-class-tags-mismatch", oldMap, nextMap);
  const stripDoTags = (tags: readonly string[] = []) =>
    tags
      .filter(
        (tag) =>
          !tag.startsWith("alchemy:dos:") &&
          !tag.startsWith("alchemy:do:") &&
          !tag.startsWith("alchemy:migration-tag:"),
      )
      .sort();
  if (canonical(stripDoTags(old!.tags ?? [])) !== canonical(stripDoTags(metadata.tags)))
    fail(
      "declared-class-tags-mismatch",
      { tags: stripDoTags(old!.tags ?? []) },
      { tags: stripDoTags(metadata.tags) },
    );
  // Keep the ordinary settings and metadata guards. Only this exact declaration's class/tag delta is projected as observed.
  versionMetadata(
    {
      ...upload,
      request: { ...upload.request, metadata: { ...metadata, migrations: undefined } },
      previousSettings: {
        ...old!,
        bindings: [...(old!.bindings ?? []), ...expected],
        tags: metadata.tags,
      },
    },
    proof?.versions,
    proof?.baseline,
    proof?.repair,
  );
  return {
    entry: digest(canonical(entry)),
    oldTag: migration!.oldTag!,
    newTag: migration!.newTag!,
    newSqliteClasses: [...entry.newSqliteClasses],
    addedBindings: expected,
  };
}
