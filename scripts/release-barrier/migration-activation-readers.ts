import type { CompiledStack } from "alchemy/Stack";
import type { StateService } from "alchemy/State/State";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import { Cause, Config, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { createHash } from "node:crypto";
import { openDeploymentReadiness, withinDeadline } from "../database-budget-readiness.ts";
import { readActivePlacements, readCurrentDeployment } from "./cloudflare.ts";
import { readForwardPacket } from "./forward-model.ts";
import { journalKey } from "./forward-journal.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import type { MigrationReaderEvidence } from "./migration-activation-contract.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { servingWorkerSettings, workerInputHash } from "./serving-worker-input.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";

const readerRoles = ["Api", "AppPages", "PoolWorker"] as const;
const journalHeader = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  sealed: Schema.Unknown,
  complete: Schema.Boolean,
  previous: Schema.optional(Schema.Unknown),
});
const workerIdentity = Schema.Struct({ accountId: Schema.String, workerName: Schema.String });
const nullable = Schema.NullOr(Schema.String);
const appRow = Schema.Struct({
  id: Schema.String,
  code: Schema.String,
  owner: Schema.String,
  active: nullable,
  build: nullable,
  commit: nullable,
  pools: Schema.Array(
    Schema.Struct({
      organization: Schema.String,
      slot: Schema.String,
      version: nullable,
      authorization: nullable,
      membership: nullable,
    }),
  ),
});
const appPage = `SELECT a.id,a.code,a.owner,a.active_deployment AS active,
  d.build,d.source_commit AS commit,
  COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'organization',o.id,'slot',entry.key,'version',entry.value->>'version',
    'authorization',entry.value->>'authorization','membership',entry.value->>'membership')
    ORDER BY o.id COLLATE "C",entry.key COLLATE "C")
    FROM organization o CROSS JOIN LATERAL
      jsonb_each(COALESCE(o.metadata::jsonb->'basaltPools','{}'::jsonb)) entry
    WHERE entry.value->>'app'=a.id), '[]'::jsonb) AS pools
  FROM executor_apps a LEFT JOIN executor_deployments d
    ON d.id=a.active_deployment AND d.code=a.code AND d.owner=a.owner
  WHERE a.id COLLATE "C">$1 COLLATE "C" ORDER BY a.id COLLATE "C" LIMIT 201`;

const associationLimit = 50;
const poolAssociations = `WITH pools AS (
    SELECT id,metadata::jsonb->'basaltPools' AS entries FROM organization
  )
  SELECT o.id AS organization,entry.slot,entry.value->>'app' AS app,a.owner AS actual_owner,
    CASE WHEN entry.slot IS NULL THEN 'invalid-pool-map'
      WHEN entry.value->>'app' IS NULL THEN 'missing-app-reference'
      WHEN jsonb_typeof(entry.value->'app')<>'string'
        OR entry.value->>'app' !~ '^app_[A-Za-z0-9_-]{1,251}$' THEN 'invalid-app-reference'
      WHEN a.id IS NULL THEN 'app-missing' ELSE 'wrong-owner' END AS reason
  FROM pools o CROSS JOIN LATERAL (
    SELECT key AS slot,value FROM jsonb_each(
      CASE WHEN jsonb_typeof(o.entries)='object' THEN o.entries ELSE '{}'::jsonb END)
    UNION ALL SELECT NULL::text,NULL::jsonb
      WHERE o.entries IS NOT NULL AND jsonb_typeof(o.entries)<>'object'
  ) entry LEFT JOIN executor_apps a ON a.id=entry.value->>'app'
  WHERE entry.slot IS NULL OR entry.value->>'app' IS NULL
    OR jsonb_typeof(entry.value->'app')<>'string'
    OR entry.value->>'app' !~ '^app_[A-Za-z0-9_-]{1,251}$'
    OR a.owner IS DISTINCT FROM 'organization:' || o.id
  ORDER BY o.id COLLATE "C",entry.slot COLLATE "C" NULLS FIRST LIMIT ${associationLimit + 1}`;

function diagnosticId(value: unknown) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    !/[^A-Za-z0-9_-]/.test(value) &&
    !/^(?:(?:sk|pk|ghp|gho|ghu|ghs|ghr|github_pat)[_-]|(?:AKIA|ASIA)[A-Z0-9]{16}$)/i.test(value)
    ? value
    : null;
}

function associationDelta(rows: Record<string, unknown>[]) {
  const changed = rows.slice(0, associationLimit).map((row, index) => {
    const organization = diagnosticId(row.organization);
    const slot = row.slot === null ? null : (diagnosticId(row.slot) ?? "invalid-id");
    const app =
      row.app === null
        ? null
        : typeof row.app === "string" && /^app_[A-Za-z0-9_-]{1,251}$/.test(row.app)
          ? (diagnosticId(row.app) ?? "invalid-id")
          : "invalid-id";
    const owner =
      typeof row.actual_owner === "string"
        ? /^(organization|user):(.+)$/.exec(row.actual_owner)
        : null;
    const actualOwner =
      row.actual_owner === null
        ? null
        : owner && diagnosticId(owner[2]) !== null
          ? `${owner[1]}:${owner[2]}`
          : "invalid-owner";
    const reason =
      typeof row.reason === "string" &&
      [
        "invalid-pool-map",
        "missing-app-reference",
        "invalid-app-reference",
        "app-missing",
        "wrong-owner",
      ].includes(row.reason)
        ? row.reason
        : "invalid-diagnostic-row";
    const context = { organization: organization ?? "invalid-id", slot, app };
    return {
      path: `poolAssociations[${index}]`,
      old: canonical({
        ...context,
        owner: organization === null ? "invalid-owner" : `organization:${organization}`,
      }),
      new: canonical({ ...context, owner: actualOwner, reason }),
    };
  });
  if (rows.length > associationLimit)
    changed.push({ path: "poolAssociations.inventory", old: "complete", new: "overflow" });
  return { fqn: "SQL.tools", type: "PoolAssociation", changed };
}

/** App versions bind inventory drift; their JavaScript does not implement these host SQL readers. */
export async function readMigrationAppVersions(source: SqlJournalSource) {
  const session = await source.connect().catch(() => {
    throw new BarrierRefusal("migration-reader-apps-connection", "SQL.tools");
  });
  try {
    await session.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await session.query("SET LOCAL lock_timeout = '500ms'");
    await session.query("SET LOCAL statement_timeout = '3s'");
    const identity = await session.query(
      `SELECT current_database()=$1 AS database_matches,current_schema()='public' AS schema_matches,
      current_setting('transaction_read_only')='on' AS read_only`,
      [source.databaseName],
    );
    if (
      identity.rows.length !== 1 ||
      identity.rows[0]?.database_matches !== true ||
      identity.rows[0]?.schema_matches !== true ||
      identity.rows[0]?.read_only !== true
    )
      throw new BarrierRefusal("migration-reader-apps-database-identity", "SQL.tools");
    const references = await session.query(poolAssociations);
    if (references.rows.length)
      throw new BarrierRefusal(
        "migration-reader-apps-pool-association",
        "SQL.tools",
        associationDelta(references.rows),
      );
    const hash = createHash("sha256");
    let after = "";
    let count = 0;
    for (let page = 0; page < 500; page++) {
      const result = await session.query(appPage, [after]);
      if (result.rows.length > 201)
        throw new BarrierRefusal("migration-reader-apps-page-bound", "SQL.tools");
      const rows = Schema.decodeUnknownSync(Schema.Array(appRow))(result.rows);
      for (const row of rows.slice(0, 200)) {
        if (!/^app_[A-Za-z0-9_-]{1,251}$/.test(row.id) || row.id <= after)
          throw new BarrierRefusal("migration-reader-apps-pagination", "SQL.tools");
        if (row.active !== null && row.build === null)
          throw new BarrierRefusal("migration-reader-apps-version-association", "SQL.tools");
        hash.update(canonical(row)).update("\n");
        after = row.id;
        count++;
      }
      if (rows.length <= 200) {
        await session.query("COMMIT");
        return { count, fingerprint: hash.digest("hex") };
      }
    }
    throw new BarrierRefusal("migration-reader-apps-inventory-bound", "SQL.tools");
  } catch (error) {
    await session.query("ROLLBACK").catch(() => {});
    if (error instanceof BarrierRefusal) throw error;
    throw new BarrierRefusal("migration-reader-apps-inventory-unreadable", "SQL.tools");
  } finally {
    await session.end().catch(() => {
      throw new BarrierRefusal("migration-reader-apps-session-close", "SQL.tools");
    });
  }
}

export interface MigrationReaderOptions {
  state: StateService;
  stack: Pick<CompiledStack, "name" | "stage">;
  candidate: string;
  encryptionKey: string;
  accountId: string;
  apiToken: string;
  tools: SqlJournalSource;
  deploymentId: number;
  /** The candidate's, because the deployed pool reports adoption of exactly this revision. */
  poolWorkerRevision: string;
}

/** Completed receipts identify compatible code; fresh routing and singleton adoption prove it serves now. */
export const collectMigrationReaderEvidence = (options: MigrationReaderOptions) =>
  Effect.gen(function* () {
    if (
      !/^[a-f0-9]{40}$/.test(options.candidate) ||
      !Number.isSafeInteger(options.deploymentId) ||
      options.deploymentId <= 0
    )
      throw new BarrierRefusal("migration-reader-release-identity");
    const raw = yield* options.state.getOutput(journalKey(options.stack));
    if (raw === undefined) throw new BarrierRefusal("migration-reader-release-journal-missing");
    const header = Schema.decodeUnknownSync(journalHeader, { onExcessProperty: "error" })(raw);
    if (!header.complete || header.candidate !== options.candidate)
      throw new BarrierRefusal("migration-reader-release-journal-incomplete");
    const packet = readForwardPacket(
      openRecovery(header.sealed, options.encryptionKey, header.candidate, header.manifest),
    );
    const { manifest, receipt } = packet;
    if (
      manifest.candidate !== options.candidate ||
      manifest.stack !== options.stack.name ||
      manifest.stage !== options.stack.stage ||
      receipt.manifest !== header.manifest ||
      receipt.phase !== "complete" ||
      receipt.pending ||
      receipt.pendingUpload ||
      receipt.pendingContainer ||
      receipt.failure
    )
      throw new BarrierRefusal("migration-reader-release-receipt-incomplete");
    const workers: MigrationReaderEvidence["workers"][number][] = [];
    let pool: { accountId: string; scriptName: string; imageInput: string } | undefined;
    for (const role of readerRoles) {
      const frozen = manifest.workers.filter((worker) => worker.id === role);
      const accepted = receipt.accepted.filter((worker) => worker.worker === role);
      const activated = receipt.activated.filter((worker) => worker.worker === role);
      if (
        frozen.length !== 1 ||
        accepted.length !== 1 ||
        activated.length !== 1 ||
        activated[0]!.versionId !== accepted[0]!.versionId
      )
        throw new BarrierRefusal("migration-reader-release-role-coverage", role);
      const resource = yield* options.state.get({
        stack: options.stack.name,
        stage: options.stack.stage,
        fqn: role,
      });
      if (
        !resource ||
        !("resourceType" in resource) ||
        resource.resourceType !== "Cloudflare.Worker" ||
        (resource.status !== "created" && resource.status !== "updated")
      )
        throw new BarrierRefusal("migration-reader-worker-state-unsettled", role);
      const identity = Schema.decodeUnknownSync(workerIdentity)(resource.attr);
      const target = { accountId: identity.accountId, scriptName: identity.workerName };
      const targetHash = digest(canonical(target));
      if (identity.accountId !== options.accountId || targetHash !== frozen[0]!.target)
        throw new BarrierRefusal("migration-reader-worker-target-drift", role);
      const current = yield* readCurrentDeployment(target);
      if (
        current.versions.length !== 1 ||
        current.versions[0]?.versionId !== accepted[0]!.versionId ||
        current.versions[0]?.percentage !== 100
      )
        throw new BarrierRefusal("migration-reader-serving-version-drift", role, {
          fqn: role,
          type: "Cloudflare.Worker",
          changed: [
            {
              path: "deployment.versions",
              old: canonical([{ versionId: accepted[0]!.versionId, percentage: 100 }]),
              new: canonical(current.versions),
            },
          ],
        });
      workers.push({
        role,
        target: targetHash,
        versionId: current.versions[0]!.versionId,
        acceptedVersionId: accepted[0]!.versionId,
        percentage: 100,
      });
      if (role === "PoolWorker") {
        const versions = yield* readActivePlacements(target, current.versions);
        const imageInput = workerInputHash(servingWorkerSettings(versions, current.versions));
        if (!imageInput || imageInput !== packet.frozen.containers[0]?.inputHash)
          throw new BarrierRefusal("migration-reader-pool-image-input-drift", role);
        pool = { ...target, imageInput };
      }
    }
    if (!pool) throw new BarrierRefusal("migration-reader-pool-identity-missing", "PoolWorker");
    const target = {
      candidate: options.candidate,
      workerInput: options.poolWorkerRevision,
      imageHash: pool.imageInput,
    };
    const key = yield* Config.Redacted("POOL_DEPLOYMENT_KEY");
    const selected = pool;
    yield* Effect.tryPromise({
      try: async () => {
        const opening = openDeploymentReadiness({
          accountId: selected.accountId,
          worker: selected.scriptName,
          key: Redacted.value(key),
          target,
        });
        const connection = await withinDeadline(opening, 20_000).catch((error: unknown) => {
          // A bridge can finish opening after its caller's deadline.
          void opening.then((late) => late.close()).catch(() => {});
          throw error;
        });
        try {
          const adoption = await connection.adoption(AbortSignal.timeout(15_000));
          if (!adoption.adopted)
            throw new BarrierRefusal("migration-reader-pool-code-not-adopted", "PoolWorker");
        } finally {
          await connection.close();
        }
      },
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("migration-reader-pool-adoption-unreadable", "PoolWorker"),
    });
    const apps = yield* Effect.tryPromise({
      try: () => readMigrationAppVersions(options.tools),
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("migration-reader-apps-inventory-unreadable", "SQL.tools"),
    });
    return {
      release: {
        candidate: options.candidate,
        deploymentId: options.deploymentId,
        receiptDigest: digest(canonical(receipt)),
      },
      workers,
      poolAdoption: {
        candidate: options.candidate,
        poolWorkerRevision: options.poolWorkerRevision,
        imageInput: pool.imageInput,
      },
      apps,
    } satisfies MigrationReaderEvidence;
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: options.apiToken })),
    ),
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      return Effect.fail(
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("migration-reader-evidence-unreadable"),
      );
    }),
  );
