import type { D1Progress, PreparedD1 } from "./declared-d1-types.ts";
import type { PreparedBucket, BucketProgress } from "./declared-buckets.ts";
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
  const resources = new Map<
    string,
    {
      resource: PreparedBucket | PreparedD1;
      lifecycle: BucketProgress["lifecycle"];
      outcome: BucketProgress["outcome"];
    }
  >();
  let declaration: string | undefined;
  let readiness: DeclaredReadiness | undefined;
  return {
    async declared(progress: BucketProgress | D1Progress) {
      const value = {
        resource: "bucket" in progress ? progress.bucket : progress.database,
        lifecycle: progress.lifecycle,
        outcome: progress.outcome,
      };
      if (declaration && declaration !== value.resource.declaration)
        throw declaredMismatch(
          "declared-evidence-intent-drift",
          value.resource.fqn,
          { declaration },
          { declaration: value.resource.declaration },
          value.resource.native.resourceType,
        );
      const previous = resources.get(value.resource.fqn);
      if (
        (previous &&
          canonical({ ...previous.resource, databaseId: undefined }) !==
            canonical({ ...value.resource, databaseId: undefined })) ||
        (previous &&
          "databaseId" in previous.resource &&
          previous.resource.databaseId !== undefined &&
          (!("databaseId" in value.resource) ||
            previous.resource.databaseId !== value.resource.databaseId))
      )
        throw declaredMismatch(
          "declared-evidence-identity-drift",
          value.resource.fqn,
          previous.resource,
          value.resource,
          value.resource.native.resourceType,
        );
      declaration = value.resource.declaration;
      resources.set(value.resource.fqn, structuredClone(value));
      const entries = [...resources.values()].sort((a, b) =>
        a.resource.fqn.localeCompare(b.resource.fqn),
      );
      const descriptor = {
        schemaVersion: 1,
        purpose: "declared-changes",
        candidate,
        declaration,
        resources: entries.map(({ resource }) => ({
          fqn: resource.fqn,
          entry: resource.entry,
          target: resource.target,
          native: resource.native,
          initialLifecycle: resource.initialLifecycle,
          resume: resource.resume,
          ...("databaseId" in resource ? { databaseId: resource.databaseId } : {}),
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
        resources: entries.map(({ resource, lifecycle, outcome }) => ({
          fqn: resource.fqn,
          entry: resource.entry,
          type: resource.native.resourceType,
          providerVersion: resource.native.providerVersion,
          target: digest(
            canonical({
              ...resource.target,
              ...("databaseId" in resource ? { databaseId: resource.databaseId } : {}),
            }),
          ),
          identity: digest(resource.native.instanceId),
          initialLifecycle: resource.initialLifecycle,
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
        .sort((a, b) => a.resource.fqn.localeCompare(b.resource.fqn))
        .map(({ resource, lifecycle, outcome }) => {
          const ready =
            readiness?.resources.find((item) => item.fqn === resource.fqn)?.ready === true;
          return `| ${resource.fqn} | ${resource.native.resourceType} / ${resource.native.resourceType === "Cloudflare.D1Database" ? "create-d1-database" : "create-bucket"} | ${resource.native.providerVersion} | ${resource.initialLifecycle} | ${lifecycle} | ${outcome} | ${ready ? "observed-ready" : "not-ready"} | ${digest(canonical({ ...resource.target, ...("databaseId" in resource ? { databaseId: resource.databaseId } : {}) }))} | ${digest(resource.native.instanceId)} |`;
        });
      for (const resource of readiness?.resources ?? [])
        if (!resources.has(resource.fqn))
          rows.push(
            `| ${resource.fqn} | ${resource.type} / observe | unchanged | observed | ${resource.lifecycle} | observation only | ${resource.ready ? "observed-ready" : "not-ready"} | ${resource.target ?? "unconfirmed"} | ${resource.identity ?? "unconfirmed"} |`,
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
