import { Schema } from "effect";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { historyActivationDefinitions, runHistoryOperator } from "../pool-history-operator.ts";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import type { JournalFunction } from "./migration-activation-database.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export interface HistoryOptions {
  worker: string;
  plan: string;
  operation: "journal-activation";
  apply: boolean;
  readersReady?: string;
}
export type HistoryOperator = (options: HistoryOptions, accountId: string) => Promise<unknown>;
const migrations = Schema.Array(
  Schema.Struct({ name: Schema.String, statements: Schema.Array(Schema.String) }),
);

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
 * Everything that must match deployed code, read from the candidate's own prepared checkout. The
 * client calling this runs from main, so a fix to it never changes what a plan binds.
 */
export async function candidateSources(candidate: string, root: string) {
  const cloud = join(root, ".upstream/apps/hosted/cloud");
  const module = (path: string): Promise<unknown> => import(pathToFileURL(join(root, path)).href);
  let step = "checkout.head";
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (git("rev-parse", "HEAD").trim() !== candidate) throw new Error();
    step = "checkout.unmodified";
    git(
      "diff",
      "--exit-code",
      candidate,
      "--",
      "scripts/pool-history-operator.ts",
      "src/pool/model-history",
      "patches",
    );
    step = "carry.0560";
    const carries = git("ls-tree", "-r", "--name-only", candidate, "patches")
      .trim()
      .split("\n")
      .filter((path) => /^patches\/0560-.*\.(?:patch|json)$/u.test(path));
    if (!carries.some((path) => path.endsWith(".patch"))) throw new Error();
    step = "sources";
    const paths = [
      "scripts/pool-history-operator.ts",
      "src/pool/model-history/schema.ts",
      ...carries,
    ];
    const fingerprints: [string, string][] = paths.map((path) => [
      path,
      digest(git("show", `${candidate}:${path}`)),
    ]);
    const hostedPath = ".upstream/apps/hosted/server/src/implementation/";
    const [hosted, inactive, cli, operatorSource] = await Promise.all([
      readFile(join(root, hostedPath, "change-journal-schema.ts"), "utf8"),
      readFile(join(root, hostedPath, "deferred-change-schema.ts"), "utf8"),
      readFile(join(cloud, "src/migrate.ts"), "utf8"),
      readFile(join(root, "scripts/pool-history-operator.ts"), "utf8"),
    ]);
    step = "activation.capability";
    if (
      !cli.includes("--activate-change-journal") ||
      !cli.includes("--readers-ready=checkpoint-count-v1") ||
      !operatorSource.includes('"journal-activation"') ||
      !operatorSource.includes("historyJournalActivationPath")
    )
      throw new Error();
    step = "definitions";
    const [schema, protocol, revision] = await Promise.all([
      module("src/pool/model-history/schema.ts"),
      module("src/pool/model-history/operator.ts"),
      module(hostedPath + "pool-worker-revision.ts"),
    ]);
    if (!record(schema) || !record(protocol) || !record(revision)) throw new Error();
    const poolWorkerRevision = revision.poolWorkerRevision;
    if (typeof poolWorkerRevision !== "string" || !/^[a-f0-9]{64}$/u.test(poolWorkerRevision))
      throw new Error();
    step = "schema";
    const prepared = Schema.decodeUnknownSync(migrations)(schema.historySchemaMigrations);
    const active = Schema.decodeUnknownSync(
      Schema.Struct({ name: Schema.String, statements: Schema.Array(Schema.String) }),
    )(schema.historyJournalActivationMigration);
    if (
      !prepared.some((entry) => entry.name === "model_request_history_v9_change_journal_prepare") ||
      active.name !== "model_request_history_v10_change_journal_activate"
    )
      throw new Error();
    const poolPrepared = prepared.flatMap((entry) => entry.statements).join("\n");
    fingerprints.push(
      ["hosted", digest(hosted)],
      ["hosted-inactive", digest(inactive)],
      ["cli", digest(cli)],
      ["pool-prepared", digest(poolPrepared)],
      ["pool-active", digest(canonical(active))],
    );
    step = "functions";
    return {
      fingerprint: digest(canonical({ candidate, sources: fingerprints })),
      cloud,
      poolWorkerRevision,
      definitions: { ...schema, ...protocol },
      hosted: {
        prepared: functions(hosted, ["hosted_change_revision", "hosted_project_changes"]),
        active: functions(hosted, ["hosted_flush_changes"]),
        inactive: functions(inactive, ["hosted_flush_changes"]),
      },
      pool: {
        prepared: functions(poolPrepared, [
          "basalt_pool_change_revision",
          "basalt_pool_project_changes",
        ]),
        active: functions(active.statements.join("\n"), [
          "basalt_pool_change",
          "basalt_pool_flush_changes",
        ]),
        inactive: functions(poolPrepared, ["basalt_pool_change"]),
      },
    };
  } catch (error) {
    if (error instanceof BarrierRefusal) throw error;
    throw new BarrierRefusal("migration-activation-source-capability", "candidate", {
      fqn: "candidate",
      type: "MigrationSource",
      changed: [{ path: step, changed: true }],
    });
  }
}

/**
 * The trusted operator holds the deployed Worker's report to its own copy of these definitions.
 * When main's have moved past the candidate's, main no longer describes production.
 */
export function assertTrustedDefinitions(
  trusted: Readonly<Record<string, unknown>>,
  deployed: Readonly<Record<string, unknown>>,
) {
  for (const [name, value] of Object.entries(trusted)) {
    const old = digest(canonical(deployed[name] ?? null));
    const current = digest(canonical(value ?? null));
    if (old !== current)
      throw new BarrierRefusal("migration-activation-tooling-definition-drift", name, {
        fqn: name,
        type: "MigrationDefinition",
        changed: [{ path: "digest", old, new: current }],
        why: ["main's migration definition differs from production; release main first"],
      });
  }
}

/** Main's operator and transport, bound to the candidate's sources. */
export async function sourceContract(candidate: string, root: string) {
  const { definitions, ...sources } = await candidateSources(candidate, root);
  assertTrustedDefinitions(historyActivationDefinitions, definitions);
  const operator: HistoryOperator = runHistoryOperator;
  return { ...sources, operator };
}
