import { classConstraint, classRefusal } from "./class-refusal.ts";
import { withOperation } from "./operation-failure.ts";
import { Effect } from "effect";
import type { ClassRecord } from "./class-history.ts";
import type { ClassContent, ClassProgress } from "./declared-class-contract.ts";
import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import { contentDigest, expansionContent, payloadDigest } from "./class-payload.ts";
import { cloneRequest } from "./class-clone.ts";
import { canonical, digest } from "./manifest.ts";

/**
 * State keeps a class record's digests, not its module bytes. Re-derive them from the frozen
 * baseline version's content (a version-qualified read) and accept them only when they reproduce
 * every digest the record was saved with.
 */
export function restoreClassRecord(
  saved: ClassRecord,
  baseline: ClassContent,
  entry: SqliteClassDeclaration,
  fqn?: string,
): ClassRecord {
  const content = expansionContent(baseline, entry);
  const request = {
    ...saved.clone.request,
    modules: cloneRequest(saved.baseline, baseline, saved.marker, fqn).modules,
  };
  const restored: ClassRecord = {
    ...saved,
    recovery: {
      ...saved.recovery,
      files: content.files.map((file) => ({
        name: file.name,
        type: file.type,
        base64: Buffer.from(file.bytes).toString("base64"),
      })),
    },
    clone: { ...saved.clone, request },
  };
  if (
    content.mainModule !== saved.recovery.mainModule ||
    contentDigest(content) !== saved.content ||
    digest(canonical(request)) !== saved.clone.payload
  )
    throw classRefusal("declared-class-recovery-invalid", fqn, [
      { path: "recovery.mainModule", old: saved.recovery.mainModule, new: content.mainModule },
      { path: "recovery.contentHash", old: saved.content, new: contentDigest(content) },
      { path: "clone.payloadHash", old: saved.clone.payload, new: digest(canonical(request)) },
    ]);
  classRecoveryRequest(restored, fqn);
  return restored;
}

/** The exact PUT the record's digests describe; its bytes come from `restoreClassRecord`. */
export function classRecoveryRequest(saved: ClassRecord, fqn?: string) {
  const content: ClassContent = {
    mainModule: saved.recovery.mainModule,
    files: saved.recovery.files.map((file) => {
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64)
        throw classConstraint(
          "declared-class-recovery-invalid",
          fqn,
          "recovery.files.encoding",
          "canonical-base64",
          "invalid",
        );
      return { name: file.name, type: file.type, bytes: new Uint8Array(bytes) };
    }),
  };
  const request = {
    accountId: saved.baseline.accountId,
    scriptName: saved.baseline.scriptName,
    bindingsInherit: "strict" as const,
    metadata: structuredClone(saved.recovery.metadata),
    files: content.files.map(
      (file) => new File([new Uint8Array(file.bytes)], file.name, { type: file.type }),
    ),
  };
  if (contentDigest(content) !== saved.content || payloadDigest(request, content) !== saved.payload)
    throw classRefusal("declared-class-recovery-invalid", fqn, [
      { path: "recovery.contentHash", old: saved.content, new: contentDigest(content) },
      { path: "recovery.payloadHash", old: saved.payload, new: payloadDigest(request, content) },
    ]);
  return request;
}

export const recordClassProgress = (
  record: (value: ClassProgress) => Promise<void>,
  fqn: string,
  saved: ClassRecord,
  outcome: ClassProgress["outcome"],
  phase?: ClassProgress["phase"],
) =>
  Effect.tryPromise({
    try: () =>
      record({
        fqn,
        entry: saved.entry,
        declaration: saved.declaration,
        native: structuredClone(saved.native),
        baseline: structuredClone(saved.baseline),
        newTag: saved.newTag,
        payload: saved.payload,
        request: classRecoveryRequest(saved, fqn),
        outcome,
        ...(phase ? { phase } : {}),
        clone: {
          request: structuredClone(saved.clone.request),
          versionId: saved.clone.versionId,
          payload: saved.clone.payload,
          status: saved.clone.status,
        },
        ...(saved.observed ? { observed: structuredClone(saved.observed) } : {}),
        ...(saved.startupTimeMs !== undefined ? { startupTimeMs: saved.startupTimeMs } : {}),
      }),
    catch: (error) => error,
  }).pipe(withOperation(fqn, "record-class-expansion"));
