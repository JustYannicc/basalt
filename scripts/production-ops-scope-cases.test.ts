import assert from "node:assert/strict";
import test from "node:test";
import { selectScopeCases } from "./production-ops/scope-cases.ts";

test("scope selection preserves titles and isolates only the selected binding", () => {
  const plan = {
    cloudProductionOpsHostIdentity: {
      title: "Cloud host (exact).",
      file: "production-ops-migrations.spec.ts",
    },
    cloudProductionOpsPhysicalDatabase: {
      title: "Cloud physical",
      file: "production-ops-database.spec.ts",
    },
    unrelated: { title: "Cloud host (exact).", file: "other.spec.ts" },
  };
  const selected = selectScopeCases(plan, "Cloud host");
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.binding, "host");
  assert.ok(new RegExp(selected[0]!.pattern).test("Cloud host (exact)."));
  assert.equal(new RegExp(selected[0]!.pattern).test("Cloud host exactX"), false);
  assert.equal(selectScopeCases(plan, "physical")[0]!.binding, undefined);
  assert.throws(() => selectScopeCases(plan, "missing"), /No production-operation/);
});
