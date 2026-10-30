import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexWebSocketPlan } from "../src/pool/codex-websockets.ts";

interface Options { worker: string; plan: string; apply: boolean }
interface PlanFile { accountId: string; worker: string; selection: CodexWebSocketPlan }
interface Platform {
  env: { POOL_OPERATIONS: { fetch(request: Request): Promise<Response> } };
  dispose(): Promise<void>;
}

export function operatorOptions(args: string[]): Options {
  if ((args.length !== 4 && args.length !== 6) || args[0] !== "--worker" || args[2] !== "--plan"
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(args[1] ?? "") || !args[3]
    || (args.length === 6 && (args[4] !== "--apply" || args[5] !== "--go")))
    throw new Error("Use --worker <deployed-script> --plan <private-file> [--apply --go]");
  return { worker: args[1]!, plan: args[3]!, apply: args.length === 6 };
}

function plan(value: unknown): CodexWebSocketPlan {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator result");
  const row = value as Record<string, unknown>;
  const integer = (field: string): number => {
    const count = row[field];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
      throw new Error("Invalid operator counts");
    return count;
  };
  if (typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)) throw new Error("Invalid operator digest");
  const total = integer("total"), enabled = integer("enabled"), pending = integer("pending");
  const writes = integer("writes"), limit = integer("limit");
  if (enabled + pending !== total || writes !== total || limit !== 50) throw new Error("Invalid operator selection");
  return { total, enabled, pending, writes, limit, digest: row.digest };
}

/** Cloudflare's remote service-binding proxy reaches only the explicitly named private entrypoint. */
export async function runPoolWebSocketOperator(options: Options, accountId: string,
  connect?: (configPath: string) => Promise<Platform>) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  let approval: PlanFile | undefined;
  if (options.apply) {
    const file = JSON.parse(await readFile(options.plan, "utf8")) as PlanFile;
    if (file.accountId !== accountId || file.worker !== options.worker) throw new Error("Plan target changed");
    approval = { ...file, selection: plan(file.selection) };
    if (approval.selection.writes > approval.selection.limit) throw new Error("Plan exceeds the bounded pass");
  }
  const directory = await mkdtemp(join(tmpdir(), "pool-websocket-operator-"));
  let platform: Platform | undefined;
  const receiptPath = `${options.plan}.result.json`;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ name: "pool-websocket-operator", account_id: accountId,
      compatibility_date: "2026-09-08", services: [{ binding: "POOL_OPERATIONS", service: options.worker,
        entrypoint: "PoolOperations", remote: true }] }), { mode: 0o600 });
    const open = connect ?? (async (configPath: string) => {
      const { getPlatformProxy } = createRequire(new URL("./startup-profiler/package.json", import.meta.url))("wrangler");
      return getPlatformProxy({ configPath, persist: false, remoteBindings: true });
    });
    platform = await open(configPath);
    if (approval) {
      // A lost response must not authorize a second apply. Retain the started receipt for inspection.
      await writeFile(receiptPath, JSON.stringify({ status: "started", selection: approval.selection }), { mode: 0o600, flag: "wx" });
    }
    const response = await platform.env.POOL_OPERATIONS.fetch(new Request("http://pool-operations/codex-websockets", {
      ...(approval ? { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest: approval.selection.digest, pending: approval.selection.pending }) } : {}),
    }));
    if (!response.ok) throw new Error("Operator request failed; take a new dry run before any further apply");
    const value = await response.json() as Record<string, unknown>;
    const selection = plan(value);
    if (approval) {
      if (value.status !== "complete" && value.status !== "incomplete") throw new Error("Invalid apply result");
      if (typeof value.applied !== "number" || !Number.isSafeInteger(value.applied) || value.applied < 0 || value.applied > selection.writes)
        throw new Error("Invalid apply count");
      if (selection.digest !== approval.selection.digest || selection.writes !== approval.selection.writes
        || selection.pending !== approval.selection.pending || (value.status === "complete" && value.applied !== selection.writes))
        throw new Error("Apply result does not match the approved selection");
      const result = { ...selection, applied: value.applied, status: value.status };
      await writeFile(receiptPath, JSON.stringify(result), { mode: 0o600 });
      return result;
    }
    if (value.status !== "dry-run" || value.applied !== 0) throw new Error("Invalid dry-run result");
    await writeFile(options.plan, JSON.stringify({ accountId, worker: options.worker, selection }), { mode: 0o600, flag: "wx" });
    return { ...selection, applied: 0, status: "dry-run" };
  } finally {
    try { await platform?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

if (import.meta.main) {
  try {
    const result = await runPoolWebSocketOperator(operatorOptions(process.argv.slice(2)), process.env.CLOUDFLARE_ACCOUNT_ID ?? "");
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === "incomplete") process.exitCode = 1;
  } catch {
    process.stderr.write("Pool WebSocket operator failed. Inspect the private plan and result before retrying.\n");
    process.exitCode = 1;
  }
}
