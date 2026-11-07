import type { BucketProgress } from "./declared-buckets.ts";
import type { DeclaredReadiness } from "./declared-prerequisites.ts";
import { canonical, digest } from "./manifest.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { sealRecovery } from "./recovery-envelope.ts";

export const declaredRecoveryDigest = (candidate: string, declaration: string) =>
  digest(canonical({ purpose: "declared-changes", candidate, declaration }));

/** The public journal hashes physical identity; its authenticated descriptor retains the exact native ownership. */
export function declaredEvidence(
  write: (name: string, value: unknown) => Promise<void>,
  candidate: string,
  key: string,
) {
  const resources = new Map<string, BucketProgress>();
  let declaration: string | undefined;
  let readiness: DeclaredReadiness | undefined;
  return {
    async declared(value: BucketProgress) {
      if (declaration && declaration !== value.bucket.declaration)
        throw declaredMismatch(
          "declared-evidence-intent-drift",
          value.bucket.fqn,
          { declaration },
          { declaration: value.bucket.declaration },
        );
      const previous = resources.get(value.bucket.fqn);
      if (previous && canonical(previous.bucket) !== canonical(value.bucket))
        throw declaredMismatch(
          "declared-evidence-identity-drift",
          value.bucket.fqn,
          previous.bucket,
          value.bucket,
        );
      declaration = value.bucket.declaration;
      resources.set(value.bucket.fqn, structuredClone(value));
      const entries = [...resources.values()].sort((a, b) =>
        a.bucket.fqn.localeCompare(b.bucket.fqn),
      );
      const descriptor = {
        schemaVersion: 1,
        purpose: "declared-changes",
        candidate,
        declaration,
        resources: entries.map(({ bucket }) => ({
          fqn: bucket.fqn,
          entry: bucket.entry,
          target: bucket.target,
          native: bucket.native,
          initialLifecycle: bucket.initialLifecycle,
          resume: bucket.resume,
        })),
      };
      const sealed = sealRecovery(
        descriptor,
        key,
        candidate,
        declaredRecoveryDigest(candidate, declaration),
      );
      await write("declared-recovery.sealed.json", sealed);
      await write("declared-changes.json", {
        schemaVersion: 1,
        candidate,
        declaration,
        resources: entries.map(({ bucket, lifecycle, outcome }) => ({
          fqn: bucket.fqn,
          entry: bucket.entry,
          type: bucket.native.resourceType,
          providerVersion: bucket.native.providerVersion,
          target: digest(canonical(bucket.target)),
          identity: digest(bucket.native.instanceId),
          initialLifecycle: bucket.initialLifecycle,
          lifecycle,
          outcome,
          retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
        })),
      });
    },
    async declaredReadiness(value: DeclaredReadiness) {
      readiness = structuredClone(value);
      await write("declared-readiness.json", { schemaVersion: 1, candidate, ...value });
    },
    summary(
      disposition: "complete" | "failed",
      activated: readonly { worker: string; versionId: string }[],
    ) {
      if (!resources.size && !readiness?.resources.length) return "";
      const rows = [...resources.values()]
        .sort((a, b) => a.bucket.fqn.localeCompare(b.bucket.fqn))
        .map(({ bucket, lifecycle, outcome }) => {
          const ready =
            readiness?.resources.find((item) => item.fqn === bucket.fqn)?.ready === true;
          return `| ${bucket.fqn} | Cloudflare.R2.Bucket / create-bucket | ${bucket.native.providerVersion} | ${bucket.initialLifecycle} | ${lifecycle} | ${outcome} | ${ready ? "observed-ready" : "not-ready"} | ${digest(canonical(bucket.target))} | ${digest(bucket.native.instanceId)} |`;
        });
      for (const resource of readiness?.resources ?? [])
        if (!resources.has(resource.fqn))
          rows.push(
            `| ${resource.fqn} | Cloudflare.R2.Bucket / observe | unchanged | observed | ${resource.lifecycle} | observation only | ${resource.ready ? "observed-ready" : "not-ready"} | ${resource.target ?? "unconfirmed"} | ${resource.identity ?? "unconfirmed"} |`,
          );
      return `## Declared storage

Candidate: ${candidate}. Declaration: ${declaration ?? readiness?.declaration}. Release disposition: ${disposition}.

Activated Worker versions: ${activated.length}${activated.length ? ` (${activated.map((item) => `${item.worker}@${item.versionId}`).join(", ")})` : ""}.

| Resource | Type / operation | Provider version | Initial lifecycle | Current lifecycle | Creation outcome | Readiness | Target SHA-256 | Native identity SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

Retain data, native row and recovery descriptor through code rollback. Unknown creation never authorizes another create or adoption.

`;
    },
  };
}
