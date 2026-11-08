import type { SqliteClassDeclaration } from "./declared-change-schema.ts";
import { classNamespaces, type ClassObservation } from "./declared-class-contract.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { canonical, digest } from "./manifest.ts";
import type { ClassRecord } from "./class-history.ts";

const local = (
  binding: NonNullable<ClassObservation["settings"]["bindings"]>[number],
  script: string,
): binding is Extract<
  NonNullable<ClassObservation["settings"]["bindings"]>[number],
  { type: "durable_object_namespace" }
> =>
  binding.type === "durable_object_namespace" &&
  (!binding.scriptName || binding.scriptName === script);
const projection = (value: ClassObservation, added: readonly string[]) => ({
  ...value.settings,
  annotations: undefined,
  tags: undefined,
  migrations: undefined,
  bindings: (value.settings.bindings ?? []).filter((binding) => !added.includes(binding.name)),
});

/** A fresh active version, migration tag and namespace mapping establish readiness without invoking the new class. */
export function assertClassObservation(
  entry: SqliteClassDeclaration,
  saved: ClassRecord,
  observed: ClassObservation,
  attributable = false,
) {
  const fail = (reason: string, expected: unknown, actual: unknown): never => {
    throw declaredMismatch(reason, entry.fqn, expected, actual, entry.type);
  };
  if (
    observed.workerId !== saved.baseline.workerId ||
    observed.accountId !== saved.baseline.accountId ||
    observed.scriptName !== saved.baseline.scriptName ||
    observed.migrationTag !== saved.newTag
  )
    fail(
      "declared-class-prerequisite-drift",
      {
        workerIdentityHash: digest(saved.baseline.workerId),
        accountIdentityHash: digest(saved.baseline.accountId),
        scriptIdentityHash: digest(saved.baseline.scriptName),
        migrationTagHash: digest(saved.newTag),
      },
      {
        workerIdentityHash: digest(observed.workerId),
        accountIdentityHash: digest(observed.accountId),
        scriptIdentityHash: digest(observed.scriptName),
        migrationTagHash: digest(observed.migrationTag),
      },
    );
  const bindings = observed.settings.bindings ?? [];
  for (const binding of entry.addedBindings)
    if (
      !bindings.some(
        (actual) =>
          local(actual, observed.scriptName) &&
          actual.name === binding.name &&
          actual.className === binding.className &&
          typeof actual.namespaceId === "string" &&
          actual.namespaceId.length,
      )
    )
      fail("declared-class-prerequisite-missing", { binding }, { bindings });
  const before = classNamespaces(saved.baseline);
  const actual = classNamespaces(observed);
  const expectedNames = [...Object.keys(before), ...entry.newSqliteClasses].sort();
  if (
    canonical(Object.keys(actual).sort()) !== canonical(expectedNames) ||
    Object.entries(before).some(([name, id]) => actual[name] !== id) ||
    (saved.observed && canonical(classNamespaces(saved.observed)) !== canonical(actual))
  )
    fail(
      "declared-class-namespace-drift",
      {
        namespaces: saved.observed ? classNamespaces(saved.observed) : before,
        names: expectedNames,
      },
      { namespaces: actual },
    );
  if (
    attributable &&
    (observed.settings.annotations?.workersMessage !== saved.marker ||
      canonical([...(observed.settings.tags ?? [])].sort()) !== canonical([...saved.tags].sort()) ||
      canonical(projection(saved.baseline, [])) !==
        canonical(
          projection(
            observed,
            entry.addedBindings.map((binding) => binding.name),
          ),
        ))
  )
    fail(
      "declared-class-expansion-unattributable",
      { marker: saved.marker, settings: projection(saved.baseline, []) },
      {
        marker: observed.settings.annotations?.workersMessage,
        settings: projection(
          observed,
          entry.addedBindings.map((binding) => binding.name),
        ),
      },
    );
}
