/**
 * The route gateway's declare, driven through Alchemy's real apply against the plan fixture until
 * it stops or finishes. Alchemy publishes the application's image and commits its row with a local
 * `dev:` id (precreate, then a first-pass reconcile that commits `created`), uploads PoolWorker with
 * the class, and only then creates the application with the namespace the Worker resolved.
 */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ResourceState } from "alchemy/State/ResourceState";
import { Data, Effect, Exit } from "effect";
import { makePlan, productionRows, type FakeApplication, type PlanInput } from "./plan-fixture.ts";

export type Rows = Record<string, ResourceState>;

/** State with the stack's database commands settled, so its readiness commands plan as they do. */
export async function seeded(context: TestContext): Promise<Rows> {
  const rows = productionRows();
  (rows.PoolWorker as unknown as { bindings: { sid: string; data: unknown }[] }).bindings.push({
    sid: "POOL_DATABASE_READY",
    data: { bindings: [{ type: "plain_text", name: "POOL_DATABASE_READY", text: "ready" }] },
  });
  delete rows.PoolDatabase;
  const settled = await makePlan(context, {
    rows,
    declared: { poolDatabase: {} },
    settle: ["RuntimeDatabaseBudget", "Migrations", "PoolDatabase"],
    commandRuns: [],
  });
  const state = { ...settled.rows } as Rows;
  for (const fqn of ["PoolBackendBudgetRuntimeReady", "PoolBackendBudget"])
    state[fqn] = { ...productionRows().PoolDatabase!, fqn, logicalId: fqn } as ResourceState;
  return state;
}

export const declared = { poolDatabase: {}, routeGateway: true };
/** The declare policy's own selection (`include`). */
export const asDeclared = {
  declared,
  include: ["PoolWorker", "PoolBackendBudgetRuntimeReady"],
  commandRuns: [],
};

class UploadRefused extends Data.TaggedError("UploadRefused") {}

/** Where the declare's apply ends. */
export type Outcome =
  /** Cloudflare or the wire guard refuses PoolWorker's upload. */
  | "upload-refused"
  /** The upload lands; the application create is refused. */
  | "create-refused"
  /** The create reaches Cloudflare and is done there, but its State commit fails. */
  | "commit-lost"
  /** Everything lands. */
  | "finished";

/**
 * Runs the declare's apply on `rows` to `outcome`. `applications` is the account's container
 * applications, shared with later plans so they see what this apply created.
 */
export async function declareTo(
  context: TestContext,
  outcome: Outcome,
  applications: Map<string, FakeApplication>,
  rows?: Rows,
) {
  const exits: Exit.Exit<unknown, unknown>[] = [];
  const capture: NonNullable<PlanInput["capture"]> =
    outcome === "upload-refused"
      ? () => Effect.fail(new UploadRefused())
      : (upload) =>
          Effect.sync(() => {
            const proposed = upload.proposed!;
            // Cloudflare reports the class's namespace once the upload created it.
            return {
              ...proposed,
              durableObjectNamespaces: {
                ...proposed.durableObjectNamespaces,
                RouteGateway: "namespace-route-gateway",
              },
            };
          });
  const result = await makePlan(context, {
    rows: rows ?? (await seeded(context)),
    declared,
    settle: ["PoolWorker"],
    settleOnly: ["PoolWorker", "RouteGateway"],
    shadow: true,
    commandRuns: [],
    applyExits: exits,
    capture,
    applications,
    acceptContainerCreates: outcome === "commit-lost" || outcome === "finished",
    ...(outcome === "commit-lost"
      ? {
          failCommit: (fqn: string, value: unknown) =>
            fqn === "RouteGateway" &&
            !String(
              (value as { attr?: { applicationId?: unknown } }).attr?.applicationId ?? "dev:",
            ).startsWith("dev:"),
        }
      : {}),
  });
  const exit = exits[0];
  assert.ok(exit, "the declare's apply ran");
  assert.equal(Exit.isSuccess(exit), outcome === "finished", `the declare ${outcome}`);
  return { rows: { ...result.rows } as Rows, exit };
}
