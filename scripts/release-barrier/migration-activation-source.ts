import { Schema } from "effect";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, digest, BarrierRefusal } from "./manifest.ts";
import type { JournalFunction } from "./migration-activation-database.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
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
const isOperator = (value: unknown): value is HistoryOperator => typeof value === "function";
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

export async function sourceContract(candidate: string, sourceRoot = root) {
  const root = sourceRoot;
  const cloud = join(root, ".upstream/apps/hosted/cloud");
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (git("rev-parse", "HEAD").trim() !== candidate) throw new Error();
    git(
      "diff",
      "--exit-code",
      candidate,
      "--",
      "scripts/pool-history-operator.ts",
      "src/pool/model-history",
      "patches",
    );
    const carries = git("ls-tree", "-r", "--name-only", candidate, "patches")
      .trim()
      .split("\n")
      .filter((path) => /^patches\/0560-.*\.(?:patch|json)$/u.test(path));
    if (!carries.some((path) => path.endsWith(".patch"))) throw new Error();
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
    if (
      !cli.includes("--activate-change-journal") ||
      !cli.includes("--readers-ready=checkpoint-count-v1") ||
      !operatorSource.includes('"journal-activation"') ||
      !operatorSource.includes("historyJournalActivationPath")
    )
      throw new Error();
    const imported: unknown = await import("../pool-history-operator.ts");
    if (!record(imported) || !isOperator(imported.runHistoryOperator)) throw new Error();
    const schema: unknown = await import("../../src/pool/model-history/schema.ts");
    if (!record(schema)) throw new Error();
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
    return {
      fingerprint: digest(canonical({ candidate, sources: fingerprints })),
      operator: imported.runHistoryOperator,
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
  } catch {
    throw new BarrierRefusal("migration-activation-source-capability", "candidate");
  }
}
