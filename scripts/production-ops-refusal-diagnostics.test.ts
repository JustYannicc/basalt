import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit } from "../.upstream/node_modules/effect/dist/index.js";
import { atPhase, diagnostic, refusalDiagnostic } from "../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts";
import { ProviderAppsRefused } from "../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/migrations/provider-apps-schema.ts";
import { ProductionOperationRefused } from "../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/contracts.ts";

test("server guard survives nested phase wrappers without changing the public receipt", async () => {
  const result = await Effect.runPromiseExit(
    Effect.fail(new ProviderAppsRefused({ message: "Provider adoption refused: account must remain the actor's personal account" }))
      .pipe(atPhase("sql"), atPhase("config")),
  );
  assert.ok(Exit.isFailure(result));
  assert.deepEqual(refusalDiagnostic(result.cause, "config"), {
    guard: "provider_apps_read", reasonCode: "account_must_remain_the_actor_s_personal_account",
  });
  assert.deepEqual(diagnostic(result.cause, "config"), {
    format: "basalt-production-ops-failure-v1", category: "refused", phase: "sql", causeKind: "failure",
  });
  assert.deepEqual(refusalDiagnostic(Cause.fail(new ProductionOperationRefused({ message: "Migration inputs changed after review" })), "sql"), {
    guard: "runner", reasonCode: "migration_inputs_changed_after_review",
  });
});

test("unknown messages, defects and composite causes expose only fixed fallback codes", () => {
  const poison = "credential=never-retain-diagnostic-password";
  for (const cause of [Cause.fail(new Error(poison)), Cause.die(new Error(poison))]) {
    const safe = refusalDiagnostic(cause, "sql");
    assert.deepEqual(Object.keys(safe).sort(), ["guard", "reasonCode"]);
    assert.equal(safe.guard, "phase_sql");
    assert.ok(!JSON.stringify(safe).includes(poison));
  }
  const cause = Cause.combine(Cause.fail(new ProviderAppsRefused({ message: "Provider adoption refused: post-write preservation checks failed" })), Cause.die(new Error(poison)));
  assert.deepEqual(refusalDiagnostic(cause, "sql"), {
    guard: "provider_apps_openai_anthropic_v1", reasonCode: "post_write_preservation_checks_failed",
  });
});
