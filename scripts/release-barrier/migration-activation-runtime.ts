import type { CompiledStack } from "alchemy/Stack";
import { State } from "alchemy/State/State";
import { Config, Context, Effect, Redacted } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import { checkpointReaderContract } from "./migration-activation-contract.ts";
import type {
  MigrationActivationIntent,
  MigrationActivationPorts,
  MigrationActivationSnapshot,
} from "./migration-activation-contract.ts";
import { collectMigrationReaderEvidence } from "./migration-activation-readers.ts";
import { migrationActivationJournal } from "./migration-activation-state.ts";
import { readMigrationJournalDatabase } from "./migration-activation-database.ts";
import { sourceContract } from "./migration-activation-source.ts";
import { historyPlan, activateHosted } from "./migration-activation-commands.ts";
import { deploymentSqlSources } from "./sql-schema-sources.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const material = (value: MigrationActivationSnapshot) => ({
  candidate: value.candidate,
  sourceFingerprint: value.sourceFingerprint,
  readers: value.readers,
  pool: value.pool,
});

/** Promise ports keep the generic once-only engine independent of deployment services. */
export const migrationActivationPorts = (options: {
  stack: CompiledStack;
  candidate: string;
  deploymentId: number;
}) =>
  Effect.gen(function* () {
    const { stack, candidate, deploymentId } = options;
    if (
      stack.stage !== "production" ||
      !/^[a-f0-9]{40}$/u.test(candidate) ||
      !Number.isSafeInteger(deploymentId) ||
      deploymentId < 1
    )
      throw new BarrierRefusal("migration-activation-runtime-context", "candidate");
    const store = yield* Context.get(stack.services, State);
    const encryptionKey = Redacted.value(yield* Config.Redacted("EXECUTOR_ENCRYPTION_KEY"));
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
    const apiToken = Redacted.value(yield* Config.Redacted("CLOUDFLARE_API_TOKEN"));
    const authority = yield* deploymentSqlSources(store, stack);
    const workerState = yield* store.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: "PoolWorker",
    });
    if (
      !workerState ||
      !("resourceType" in workerState) ||
      workerState.resourceType !== "Cloudflare.Worker" ||
      (workerState.status !== "created" && workerState.status !== "updated") ||
      !record(workerState.attr) ||
      workerState.attr.accountId !== accountId ||
      typeof workerState.attr.workerName !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(workerState.attr.workerName)
    )
      throw new BarrierRefusal("migration-activation-worker-identity", "PoolWorker");
    const worker = workerState.attr.workerName;
    const contract = yield* Effect.tryPromise({
      try: () => sourceContract(candidate),
      catch: () => new BarrierRefusal("migration-activation-source-capability", "candidate"),
    });
    const context = yield* Effect.context<never>();
    const journal = migrationActivationJournal(store, stack, candidate, encryptionKey);
    const sourceFingerprint = digest(
      canonical({
        source: contract.fingerprint,
        worker: { accountId, worker },
        tools: digest(Redacted.value(authority.toolsUrl)),
        pool: digest(Redacted.value(authority.poolUrl)),
      }),
    );
    const assertIntent = (intent: MigrationActivationIntent) => {
      if (
        intent.before.candidate !== candidate ||
        intent.before.sourceFingerprint !== sourceFingerprint
      )
        throw new BarrierRefusal("migration-activation-target-drift", "candidate");
    };
    const assertAuthority = async () => {
      const current = await Effect.runPromise(deploymentSqlSources(store, stack));
      if (
        Redacted.value(current.toolsUrl) !== Redacted.value(authority.toolsUrl) ||
        Redacted.value(current.poolUrl) !== Redacted.value(authority.poolUrl)
      )
        throw new BarrierRefusal("migration-activation-authority-drift", "Migrations,PoolDatabase");
    };
    const observeDatabases = async () => {
      const [hosted, poolSql, pool] = await Promise.all([
        readMigrationJournalDatabase({
          source: authority.sources.tools,
          kind: "hosted",
          ...contract.hosted,
        }),
        readMigrationJournalDatabase({
          source: authority.sources.pool,
          kind: "pool",
          ...contract.pool,
        }),
        historyPlan(contract.operator, accountId, worker),
      ]);
      return {
        hosted,
        pool: {
          ...pool,
          prepared: pool.prepared && poolSql.prepared,
          active: pool.active && poolSql.active,
        },
      };
    };
    const read = async (): Promise<MigrationActivationSnapshot> => {
      if ((await sourceContract(candidate)).fingerprint !== contract.fingerprint)
        throw new BarrierRefusal("migration-activation-source-drift", "candidate");
      await assertAuthority();
      const [databases, readers] = await Promise.all([
        observeDatabases(),
        Effect.runPromise(
          collectMigrationReaderEvidence({
            state: store,
            stack,
            candidate,
            encryptionKey,
            accountId,
            apiToken,
            tools: authority.sources.tools,
            deploymentId,
          }).pipe(Effect.provideContext(context)),
        ),
      ]);
      return { candidate, sourceFingerprint, readers, ...databases };
    };
    const ports: MigrationActivationPorts = {
      ...journal,
      read,
      activate: async (intent: MigrationActivationIntent) => {
        assertIntent(intent);
        const before = await read();
        if (canonical(before) !== canonical(intent.before))
          throw new BarrierRefusal("migration-activation-plan-drift", "candidate");
        if (!before.hosted.active) await activateHosted(Redacted.value(authority.toolsUrl));
        // A lost hosted reply never reaches the pool mutation. A confirmed reply still needs SQL proof.
        const afterHosted = await read();
        if (
          !afterHosted.hosted.active ||
          canonical(material(afterHosted)) !== canonical(material(intent.before))
        )
          throw new BarrierRefusal("migration-activation-hosted-readback", "hosted");
        if (before.pool.active) return;
        const directory = await mkdtemp(join(tmpdir(), "migration-activation-apply-"));
        try {
          const plan = join(directory, "plan.json");
          await writeFile(
            plan,
            JSON.stringify({
              accountId,
              worker,
              operation: "journal-activation",
              report: intent.before.pool.report,
            }),
            { mode: 0o600, flag: "wx" },
          );
          const result = await contract.operator(
            {
              worker,
              plan,
              operation: "journal-activation",
              apply: true,
              readersReady: checkpointReaderContract,
            },
            accountId,
          );
          if (
            !record(result) ||
            result.status !== "complete" ||
            result.schemaHash !== intent.before.pool.schemaHash ||
            result.readersReady !== checkpointReaderContract
          )
            throw new Error();
        } catch {
          throw new BarrierRefusal("migration-activation-pool-command", "PoolWorker");
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      inspect: async (intent) => {
        assertIntent(intent);
        await assertAuthority();
        const observed = await observeDatabases();
        const result = {
          hosted: observed.hosted.active
            ? "active"
            : observed.hosted.prepared
              ? "prepared"
              : "unknown",
          pool: observed.pool.active ? "active" : observed.pool.prepared ? "prepared" : "unknown",
        } as const;
        return {
          status: result.hosted === "active" && result.pool === "active" ? "complete" : "pending",
          result,
        };
      },
    };
    return ports;
  });
