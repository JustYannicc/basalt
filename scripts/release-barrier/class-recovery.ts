import { Effect } from "effect";
import type { ClassRecord } from "./class-history.ts";
import type { ClassContent, ClassProgress } from "./declared-class-contract.ts";
import { contentDigest, payloadDigest } from "./class-payload.ts";
import { BarrierRefusal } from "./manifest.ts";

/** Recovery uses retained bytes, not a provider's expiring version history or a new build. */
export function classRecoveryRequest(saved: ClassRecord) {
  const content: ClassContent = {
    mainModule: saved.recovery.mainModule,
    files: saved.recovery.files.map((file) => {
      const bytes = Buffer.from(file.base64, "base64");
      if (bytes.toString("base64") !== file.base64)
        throw new BarrierRefusal("declared-class-recovery-invalid");
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
    throw new BarrierRefusal("declared-class-recovery-invalid");
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
        request: classRecoveryRequest(saved),
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
  });
