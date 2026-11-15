import { Schema } from "effect";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  historyJournalActivationMigration,
  historySchemaMigrations,
} from "../../src/pool/model-history/schema.ts";
import { runHistoryOperator } from "../pool-history-operator.ts";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import type { JournalFunction } from "./migration-activation-database.ts";

export interface HistoryOptions {
  worker: string;
  plan: string;
  operation: "journal-activation";
  apply: boolean;
  readersReady?: string;
}
export type HistoryOperator = (options: HistoryOptions, accountId: string) => Promise<unknown>;

const client = fileURLToPath(new URL("../../", import.meta.url));
const hostedPath = ".upstream/apps/hosted/server/src/implementation/";
const cliPath = ".upstream/apps/hosted/cloud/src/migrate.ts";
const operatorPath = "scripts/pool-history-operator.ts";
const schemaPath = "src/pool/model-history/schema.ts";
/**
 * Every file behind this client's own import of the pool history migrations. The client describes
 * production with that import, which is only true while each file equals the candidate's.
 */
export const poolMigrationSources = [
  "brand.ts",
  "src/pool/database-settings.ts",
  "src/pool/model-history/bulk-schema.ts",
  "src/pool/model-history/change-journal-schema.ts",
  "src/pool/model-history/change-schema.ts",
  "src/pool/model-history/import-completion-schema.ts",
  schemaPath,
  "src/pool/pool-group.ts",
] as const;
const migrations = Schema.Array(
  Schema.Struct({ name: Schema.String, statements: Schema.Array(Schema.String) }),
);

const refuse = (path: string, old: string, observed: string, type = "MigrationSource"): never => {
  throw new BarrierRefusal("migration-activation-source-capability", "candidate", {
    fqn: "candidate",
    type,
    changed: [{ path, old, new: observed }],
  });
};

/** The candidate checkout this client reads; it never falls back to its own sources. */
export function candidateSourceRoot(source: Record<string, string | undefined>) {
  const root = source.BASALT_ACTIVATION_SOURCE_ROOT ?? "";
  if (!isAbsolute(root))
    throw new BarrierRefusal("migration-activation-source-root-required", "candidate");
  return root;
}

function functions(source: string, names: readonly string[]): JournalFunction[] {
  const definitions = [
    ...source.matchAll(
      /create(?:\s+or\s+replace)?\s+function\s+(\w+)\s*\(([^)]*)\)\s+returns\s+(\w+)([\s\S]*?)language\s+(\w+)([\s\S]*?)as\s+\$\$([\s\S]*?)\$\$/gi,
    ),
  ];
  return names.map((name) => {
    const matches = definitions.filter((definition) => definition[1] === name);
    const definition = matches[0];
    if (matches.length !== 1 || !definition)
      throw new BarrierRefusal("migration-activation-function-source", name);
    return {
      name,
      args: definition[2]!
        .split(",")
        .filter((arg) => arg.trim())
        .map((arg) => arg.trim().split(/\s+/).at(-1))
        .join(", "),
      result: definition[3]!,
      language: definition[5]!,
      body: definition[7]!,
      volatility: /\bstable\b/i.test(definition[4]! + definition[6]!) ? "s" : "v",
    };
  });
}

/**
 * This client runs from main. Everything that must match deployed code is read from the live
 * candidate's own prepared checkout, so a fix to the client never changes what a plan binds.
 */
export async function sourceContract(candidate: string, root: string) {
  const cloud = join(root, ".upstream/apps/hosted/cloud");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const blob = (path: string) => {
    try {
      return execFileSync("git", ["show", `${candidate}:${path}`], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return refuse(path, "committed", "missing");
    }
  };
  const committed = (path: string) => blob(path).toString("utf8");
  const prepared = (path: string) =>
    readFile(join(root, path), "utf8").catch(() => refuse(path, "prepared", "missing"));
  let step = "checkout";
  try {
    let head = "unavailable";
    try {
      head = git("rev-parse", "HEAD").trim();
    } catch {
      // The comparison below names the unreadable checkout.
    }
    if (head !== candidate) refuse("HEAD", candidate, head, "Git.Commit");
    const edited = git(
      "diff",
      "--name-only",
      candidate,
      "--",
      operatorPath,
      "src/pool/model-history",
      "patches",
    ).trim();
    if (edited)
      throw new BarrierRefusal("migration-activation-source-capability", "candidate", {
        fqn: "candidate",
        type: "MigrationSource",
        changed: edited.split("\n").map((path) => ({ path, old: "released", new: "modified" })),
      });
    step = "patches";
    const carries = git("ls-tree", "-r", "--name-only", candidate, "patches")
      .trim()
      .split("\n")
      .filter((path) => /^patches\/0560-.*\.(?:patch|json)$/u.test(path));
    if (!carries.some((path) => path.endsWith(".patch")))
      refuse("patches/0560-*.patch", "committed", "missing");
    step = "pool-migration-sources";
    const drift = [];
    for (const path of poolMigrationSources) {
      // Raw bytes on both sides, so no decoding can make two different files look equal.
      const released = digest(blob(path));
      const own = digest(await readFile(join(client, path)));
      if (released !== own) drift.push({ path, old: released, new: own });
    }
    if (drift.length)
      throw new BarrierRefusal(
        "migration-activation-tooling-definition-drift",
        drift.map((change) => change.path).join(","),
        {
          fqn: "main",
          type: "MigrationSource",
          changed: drift,
          why: [
            "main's copy of each listed pool migration source differs from production's",
            "release main, or restore every listed file on main while a pending activation blocks releases",
          ],
        },
      );
    step = "prepared-sources";
    // The operator entry stays the candidate's bytes so the digest formula never moves; the
    // operator that runs is this client's, held to production by the deployed Worker's own report.
    const fingerprints: [string, string][] = [operatorPath, schemaPath, ...carries].map((path) => [
      path,
      digest(committed(path)),
    ]);
    const [hosted, inactive, cli, operatorSource, revision] = await Promise.all([
      prepared(hostedPath + "change-journal-schema.ts"),
      prepared(hostedPath + "deferred-change-schema.ts"),
      prepared(cliPath),
      prepared(operatorPath),
      prepared(hostedPath + "pool-worker-revision.ts"),
    ]);
    for (const flag of ["--activate-change-journal", "--readers-ready=checkpoint-count-v1"])
      if (!cli.includes(flag)) refuse(cliPath, flag, "missing");
    for (const capability of ['"journal-activation"', "historyJournalActivationPath"])
      if (!operatorSource.includes(capability)) refuse(operatorPath, capability, "missing");
    // Generated by preparation as one constant; read as text so no candidate module is evaluated.
    const poolWorkerRevision = /^export const poolWorkerRevision = "([a-f0-9]{64})";$/mu.exec(
      revision,
    )?.[1];
    if (!poolWorkerRevision)
      return refuse(hostedPath + "pool-worker-revision.ts", "64-hex revision", "unreadable");
    step = "pool-migrations";
    const poolPrepared = Schema.decodeUnknownSync(migrations)(historySchemaMigrations);
    const active = Schema.decodeUnknownSync(
      Schema.Struct({ name: Schema.String, statements: Schema.Array(Schema.String) }),
    )(historyJournalActivationMigration);
    if (
      !poolPrepared.some(
        (entry) => entry.name === "model_request_history_v9_change_journal_prepare",
      ) ||
      active.name !== "model_request_history_v10_change_journal_activate"
    )
      refuse(schemaPath, "v9 prepare and v10 activate", "missing");
    const poolStatements = poolPrepared.flatMap((entry) => entry.statements).join("\n");
    fingerprints.push(
      ["hosted", digest(hosted)],
      ["hosted-inactive", digest(inactive)],
      ["cli", digest(cli)],
      ["pool-prepared", digest(poolStatements)],
      ["pool-active", digest(canonical(active))],
    );
    const operator: HistoryOperator = (options, accountId) =>
      runHistoryOperator({ ...options, readersReady: options.readersReady }, accountId);
    return {
      fingerprint: digest(canonical({ candidate, sources: fingerprints })),
      operator,
      cloud,
      poolWorkerRevision,
      hosted: {
        prepared: functions(hosted, ["hosted_change_revision", "hosted_project_changes"]),
        active: functions(hosted, ["hosted_flush_changes"]),
        inactive: functions(inactive, ["hosted_flush_changes"]),
      },
      pool: {
        prepared: functions(poolStatements, [
          "basalt_pool_change_revision",
          "basalt_pool_project_changes",
        ]),
        active: functions(active.statements.join("\n"), [
          "basalt_pool_change",
          "basalt_pool_flush_changes",
        ]),
        inactive: functions(poolStatements, ["basalt_pool_change"]),
      },
    };
  } catch (error) {
    if (error instanceof BarrierRefusal) throw error;
    return refuse(step, "readable", "unreadable");
  }
}
