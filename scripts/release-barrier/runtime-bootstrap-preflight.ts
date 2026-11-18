import type { DeclaredChanges } from "./declared-change-schema.ts";
import { classEntries } from "./declared-class-contract.ts";
import {
  runtimeNamespaceAttachment,
  type NamespaceAttachment,
  type NamespaceBaseline,
} from "./provisioning-namespace.ts";
import { provisioningRefusal } from "./provisioning-refusal.ts";
import { fleetClassName } from "../../src/pool/fleet-deployment.ts";
import type { RuntimeColor } from "../../src/pool/image-release-plan.ts";
import { classContainersMatch, classStepContainersMatch } from "./class-observation.ts";

export type BootstrapColor = RuntimeColor;

export interface BootstrapNamespacePlan {
  color: BootstrapColor;
  /** `existing`: a prior deploy created the class. `declared`: this release's code phase creates it. */
  source: "existing" | "declared";
  attachment: NamespaceAttachment;
  /** The Worker's container links when this color bootstraps: every earlier color is bound. */
  containers: readonly string[];
}

/** The class as the reviewed add-sqlite-class migration leaves it; its namespace id is not knowable yet. */
export const declaredNamespaceId = (name: string) => `$declared:${name}`;

function projectDeclaredClass(baseline: NamespaceBaseline, name: string): NamespaceBaseline {
  const id = declaredNamespaceId(name);
  return {
    ...baseline,
    version: {
      ...baseline.version,
      bindings: [
        ...(baseline.version.bindings ?? []),
        { type: "durable_object_namespace", name, className: name, namespaceId: id },
      ],
    },
    namespaces: [
      ...baseline.namespaces,
      { id, className: name, binding: name, storage: "sqlite" as const },
    ].sort((left, right) => left.className.localeCompare(right.className)),
  };
}

/** The Worker after a color's bind code phase links its class to its container. */
function linkContainer(baseline: NamespaceBaseline, name: string): NamespaceBaseline {
  const containers = [...baseline.containers, { className: name }];
  return { ...baseline, containers, version: { ...baseline.version, containers } };
}

/**
 * Pure: what each missing color's bootstrap attaches to, predicted for the whole release. A class
 * the deploy has not created yet must be in the reviewed PoolWorker add-sqlite-class intent, on a
 * migrations-based Worker (one with `exports` cannot take a migration), and must not already be
 * named by a binding or container. Then, in release order, the class step's container guard must
 * accept alchemy's planned links, each color attaches on the Worker as its bootstrap will see it,
 * and each bind phase's ready read must keep the class record.
 */
export function bootstrapNamespacePlan(input: {
  baseline: NamespaceBaseline;
  accountId: string;
  colors: readonly BootstrapColor[];
  declarations: DeclaredChanges | undefined;
  /** The classes alchemy's controller-phase upload links to containers. */
  plannedContainers: readonly string[];
}): BootstrapNamespacePlan[] {
  const { baseline } = input;
  const declared = classEntries(input.declarations).find((entry) => entry.fqn === "PoolWorker");
  const missing = input.colors
    .map(fleetClassName)
    .filter((name) => !baseline.namespaces.some((namespace) => namespace.className === name));
  for (const name of missing) {
    const covered =
      !!declared?.newSqliteClasses.includes(name) &&
      !!declared.addedBindings.some(
        (binding) =>
          binding.name === name && binding.className === name && binding.location === "local",
      );
    const named =
      (baseline.version.bindings ?? []).some((binding) => binding.name === name) ||
      baseline.containers.some((container) => container.className === name);
    if (!covered || baseline.version.exports != null || named)
      throw provisioningRefusal(
        "provisioning-class-not-declared",
        `namespace.${name}`,
        "reviewed-PoolWorker-add-sqlite-class-on-migrations-Worker",
        { declared: covered, exports: baseline.version.exports != null, named },
      );
  }
  const planned = input.plannedContainers.map((name) => ({ className: name }));
  if (
    missing.length &&
    declared &&
    !classStepContainersMatch(declared, baseline.containers, planned)
  )
    throw provisioningRefusal(
      "provisioning-class-step-containers-mismatch",
      "namespace.containers",
      baseline.containers.map((container) => container.className).sort(),
      planned.map((container) => container.className).sort(),
    );
  let worker = missing.reduce(projectDeclaredClass, baseline);
  return input.colors.map((color) => {
    const name = fleetClassName(color);
    const containers = worker.containers.map((container) => container.className).sort();
    const attachment = runtimeNamespaceAttachment(worker, {
      accountId: input.accountId,
      namespace: { className: name, binding: name },
    });
    worker = linkContainer(worker, name);
    if (
      missing.length &&
      declared &&
      !classContainersMatch(declared, baseline.containers, worker.containers, false)
    )
      throw provisioningRefusal(
        "provisioning-class-record-container-drift",
        `namespace.${name}`,
        baseline.containers.map((container) => container.className).sort(),
        worker.containers.map((container) => container.className).sort(),
      );
    return {
      color,
      source: missing.includes(name) ? "declared" : "existing",
      attachment,
      containers,
    };
  });
}
