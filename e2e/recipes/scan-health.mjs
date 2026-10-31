import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { root, until } from "./harness.mjs";
import { workflowHealthCondition } from "../../recipes/operator/workflow-health-condition.ts";

/** Verify scan progress independently from source revisions and asynchronous first reads. */
export const verifyScanHealth = ({
  h,
  deploy,
  fixture,
  checked,
  resourceFiles,
  account,
  managementKey,
  directory,
}) =>
  Effect.gen(function* () {
    const copy = (role, configuration) =>
      Effect.gen(function* () {
        const source = JSON.parse(
          yield* Effect.promise(() =>
            readFile(join(root, `src/catalog/recipes/${role}.json`), "utf8"),
          ),
        );
        const app = yield* deploy(
          `Synthetic ${role} scan progress`,
          source.files
            .filter((file) => file.path !== "package.json")
            .map((file) => ({
              ...file,
              content:
                file.path === "common/configuration.ts"
                  ? configuration
                  : file.path === "common/installation.ts"
                    ? file.content.replace('"https://app.signalbox.run"', JSON.stringify(h.origin))
                    : file.content,
            })),
        );
        yield* h.connect(app.id, "service", {
          token: managementKey,
          organization: h.actors.organization.id,
        });
        yield* h.approved(app.id, "configure", { deliveryEnabled: false });
        return app;
      });
    const base = {
      organization: h.actors.organization.id,
      accounts: [],
      pools: [],
      channel: null,
      quietHours: null,
      operator: {
        release: null,
        availability: null,
        workflowApps: [],
        runtime: null,
        httpErrors: null,
        errorCounts: null,
      },
    };
    const release = yield* deploy("Synthetic release read", [
      {
        path: "index.ts",
        content: `
import { defineApp, query, object, router } from "apps";
const release = query({ input: object({}) }, async () => ({ workflow_runs: [{ id: 100, workflow_id: 1, run_attempt: 1, head_branch: "main", status: "completed", conclusion: "success", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" }] }));
export default defineApp({}, { tools: router({ release }) });`,
      },
    ]);
    const operator = yield* copy(
      "operator",
      `export const configuration = ${JSON.stringify({ ...base, operator: { ...base.operator, release: { app: release.id, tool: "release", input: {}, workflowId: 1, branch: "main", repository: "example/project" } } })};`,
    );
    const releaseScan = (tick) =>
      Effect.gen(function* () {
        const run = yield* h.request("POST", `${h.appPath(operator.id)}/workflow-runs`, {
          workflow: "checkProductionRelease",
          input: { target: "checkProductionRelease", tick },
        });
        yield* until(
          h.request("GET", `${h.appPath(operator.id)}/workflow-runs/${run.id}`),
          (value) => value.status === "complete",
          "release scan did not finish",
        );
        return yield* h.call(operator.id, "deliveryHealth");
      });
    const first = yield* releaseScan(1);
    const previous = yield* h.call(operator.id, "checkpoint", {
      key: "production:checkProductionRelease",
    });
    const second = yield* releaseScan(2);
    const current = yield* h.call(operator.id, "checkpoint", {
      key: "production:checkProductionRelease",
    });
    checked(
      "unchanged release keeps its confirmation cursor",
      current.observation.cursor,
      previous.observation.cursor,
    );
    checked(
      "unchanged release refreshes scan progress",
      second.scans[0].successfulAt > first.scans[0].successfulAt,
      true,
    );

    fixture.setHealth("healthy");
    const secondResource = yield* deploy("Synthetic secondary monitored account", resourceFiles);
    const pending = yield* h.connect(secondResource.id, "resource", { token: "synthetic-second" });
    const personal = yield* copy(
      "personal",
      `export const configuration = ${JSON.stringify({ ...base, accounts: [account.id, pending.id] })};`,
    );
    const healthy = yield* h.request("POST", `${h.appPath(personal.id)}/workflow-runs`, {
      workflow: "checkMyConnections",
      input: { target: account.id, tick: 1 },
    });
    const firstTarget = yield* until(
      h.request("GET", `${h.appPath(personal.id)}/workflow-runs/${healthy.id}`),
      (value) => value.status === "complete",
      "first target scan did not finish",
    );
    checked(
      "the existing target has a healthy native read before inventory expands",
      firstTarget.output.status,
      "healthy",
    );
    const waiting = fixture.holdHealth("synthetic-second");
    try {
      yield* h.call(personal.id, "tick", {}, "mutation");
      yield* Effect.promise(() => waiting).pipe(Effect.timeout("15 seconds"));
      const health = yield* h.call(personal.id, "deliveryHealth");
      checked(
        "a newly expected target cannot inherit another target's successful read",
        health.scans[0].known,
        0,
      );
      const watched = [{ name: "checkMyConnections", maximumAgeMinutes: 1 }];
      checked(
        "a pending first scan remains unknown during its grace period",
        workflowHealthCondition(
          Date.now(),
          health.configuredAt,
          watched,
          health.scans,
          health.deliveries,
        ),
        "unknown",
      );
      checked(
        "a missing first result becomes actionable at its cadence deadline",
        workflowHealthCondition(
          Date.now() + 61000,
          health.configuredAt,
          watched,
          health.scans,
          health.deliveries,
        ),
        "action",
      );
    } finally {
      fixture.releaseHealth();
    }
    const recovered = yield* until(
      h.call(personal.id, "deliveryHealth"),
      (value) => value.scans[0]?.known === 1,
      "pending first scan did not recover",
    ).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const health = yield* h.call(personal.id, "deliveryHealth");
          const runs = yield* h.request("GET", `${h.appPath(personal.id)}/workflow-runs`);
          const targets = yield* Effect.all(
            [account.id, pending.id].map((id) => h.request("GET", `${h.prefix}/accounts/${id}`)),
          );
          yield* Effect.promise(() =>
            writeFile(
              join(directory, "scan-health-recovery.json"),
              JSON.stringify({ health, runs, targets }, null, 2),
              { mode: 0o600 },
            ),
          );
          return yield* Effect.fail(error);
        }),
      ),
    );
    checked(
      "all current targets must complete a read before scan health recovers",
      recovered.scans[0].known,
      1,
    );
  });
