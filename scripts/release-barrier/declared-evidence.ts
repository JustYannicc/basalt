import type { BucketProgress } from "./declared-buckets.ts";
import type { DeclaredReadiness } from "./declared-prerequisites.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
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
  return {
    async declared(value: BucketProgress) {
      if (declaration && declaration !== value.bucket.declaration)
        throw new BarrierRefusal("declared-evidence-intent-drift", value.bucket.fqn);
      const previous = resources.get(value.bucket.fqn);
      if (previous && canonical(previous.bucket) !== canonical(value.bucket))
        throw new BarrierRefusal("declared-evidence-identity-drift", value.bucket.fqn);
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
      await write("declared-readiness.json", { schemaVersion: 1, candidate, ...value });
    },
  };
}
