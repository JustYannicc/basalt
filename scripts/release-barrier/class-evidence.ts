import type { ClassProgress } from "./declared-class-contract.ts";
import { classNamespaces } from "./declared-class-contract.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { sealRecovery } from "./recovery-envelope.ts";

/** Exact baseline bytes and identities are retained encrypted; public evidence describes the expansion separately from candidate activation. */
export function classEvidence(
  write: (name: string, value: unknown) => Promise<void>,
  candidate: string,
  key: string,
) {
  const resources = new Map<
    string,
    { value: ClassProgress; deployed: boolean; recovery: unknown }
  >();
  return {
    async expansion(value: ClassProgress) {
      const previous = resources.get(value.fqn);
      if (
        previous &&
        (previous.value.entry !== value.entry || previous.value.payload !== value.payload)
      )
        throw new BarrierRefusal("declared-class-evidence-drift", value.fqn);
      const files =
        value.request.files === undefined
          ? []
          : Array.isArray(value.request.files)
            ? value.request.files
            : [value.request.files];
      const recovery = {
        ...value,
        request: {
          ...value.request,
          files: await Promise.all(
            files.map(async (file) => {
              if (!(file instanceof File))
                throw new BarrierRefusal("declared-class-recovery-invalid", value.fqn);
              return {
                name: file.name,
                type: file.type,
                base64: Buffer.from(await file.arrayBuffer()).toString("base64"),
              };
            }),
          ),
        },
      };
      const pending = [...resources]
        .filter(([fqn]) => fqn !== value.fqn)
        .map(([, item]) => item.recovery);
      // Validate the encryption key and write the descriptor before publishing any operation intent.
      const sealed = sealRecovery(
        {
          schemaVersion: 1,
          purpose: "declared-class-expansion",
          resources: [...pending, recovery],
        },
        key,
        candidate,
        digest(canonical({ purpose: "declared-class-expansion", candidate })),
        "worker-modules",
      );
      await write("class-recovery.sealed.json", sealed);
      resources.set(value.fqn, {
        value,
        recovery,
        deployed:
          previous?.deployed === true ||
          ["pending", "unknown", "acknowledged"].includes(value.outcome),
      });
      await write("class-expansion.json", {
        schemaVersion: 1,
        candidate,
        resources: [...resources.values()].map(({ value: item, deployed }) => ({
          fqn: item.fqn,
          type: "Cloudflare.Worker",
          action: "add-sqlite-class",
          entry: item.entry,
          declaration: item.declaration,
          providerVersion: item.native.providerVersion,
          nativeIdentity: digest(item.native.instanceId),
          target: digest(
            canonical({ accountId: item.baseline.accountId, scriptName: item.baseline.scriptName }),
          ),
          payload: item.payload,
          baselineVersion: item.baseline.versionId,
          expansionVersion: item.observed?.versionId ?? null,
          baselineClone: {
            versionId: item.clone.versionId ?? null,
            payload: item.clone.payload,
            status: item.clone.status,
            routed: false,
          },
          oldTag: digest(item.baseline.migrationTag),
          newTag: digest(item.newTag),
          outcome: item.outcome,
          liveDeploymentAttempted: deployed,
          startupTimeMs: item.startupTimeMs ?? null,
          startupEvidence: item.startupTimeMs === undefined ? "unconfirmed" : "post-deployment",
          readiness: item.outcome === "ready" ? "control-plane-observed" : "unconfirmed",
          namespaceIdentity: item.observed
            ? digest(canonical(classNamespaces(item.observed)))
            : null,
          retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
        })),
      });
    },
    summary() {
      if (!resources.size) return "";
      return `## Declared class expansion

Expansion can already be live when candidate admission refuses. Startup evidence below is post-deployment; readiness observes the active version, migration tag and namespace without invoking the empty class.

| Worker | Operation | Outcome | Live deployment attempted here | Post-deployment startup ms | Observed active version | Inactive baseline clone | Payload SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${[...resources.values()].map(({ value, deployed }) => `| ${value.fqn} | add-sqlite-class | ${value.outcome} | ${deployed} | ${value.startupTimeMs ?? "unconfirmed"} | ${value.observed?.versionId ?? "unconfirmed"} | ${value.clone.versionId ?? "unconfirmed"} | ${value.payload} |`).join("\n")}

Retain the class, namespace, native row and recovery descriptor. Pre-migration Worker version IDs are not a rollback target. Recover with reviewed baseline-compatible code that still exports and binds the new class.

`;
    },
  };
}
