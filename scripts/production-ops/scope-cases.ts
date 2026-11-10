/** Each binding-change proof gets its own database and two ready runtimes before scenario work. */
const bindings: Readonly<Record<string, string>> = {
  cloudProductionOpsCredentials: "credentials",
  cloudProductionOpsHostIdentity: "host",
  cloudProductionOpsDatabaseIdentity: "database",
  cloudProductionOpsRoleIdentity: "role",
  cloudProductionOpsOptionalServer: "without-server",
  cloudProductionOpsStalePlan: "release",
};

export function selectScopeCases(
  plan: Readonly<Record<string, { readonly title: string; readonly file: string }>>,
  pattern: string,
) {
  const selected = new RegExp(pattern);
  const cases = Object.entries(plan)
    .filter(
      ([, scenario]) =>
        [
          "production-ops-migrations.spec.ts",
          "production-ops-database.spec.ts",
          "atlassian-family-adoption.spec.ts",
        ].includes(scenario.file) && selected.test(scenario.title),
    )
    .map(([id, scenario]) => ({
      title: scenario.title,
      pattern:
        "^" +
        [...scenario.title]
          .map((character) =>
            "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character,
          )
          .join("") +
        "$",
      binding: bindings[id],
    }));
  if (cases.length === 0) throw new Error("No production-operation scope scenarios matched");
  return cases;
}
