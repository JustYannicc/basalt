import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { runtimeRecoveryPath, runtimeRecoveryPrefix } from "../src/pool/runtime-recovery.ts";
import { isSigningKey, signEnvelope } from "../src/pool/token.ts";

const Selection = Schema.Struct({ instanceId: Schema.String, imageHash: Schema.String });
const Plan = Schema.Struct({ accountId: Schema.String, worker: Schema.String,
  operationId: Schema.String, selection: Selection });
interface Platform {
  env: { POOL_OPERATIONS: { fetch(request: Request): Promise<Response> } };
  dispose(): Promise<void>;
}
interface Options { worker: string; plan: string; restart: boolean }

export function runtimeOperatorOptions(args: string[]): Options {
  if ((args.length !== 4 && args.length !== 6) || args[0] !== "--worker" || args[2] !== "--plan"
    || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(args[1] ?? "") || !args[3]
    || (args.length === 6 && (args[4] !== "--restart" || args[5] !== "--go")))
    throw new Error("Use --worker <deployed-script> --plan <private-file> [--restart --go]");
  return { worker: args[1]!, plan: args[3]!, restart: args.length === 6 };
}

/** Reuse the existing authenticated Cloudflare remote binding, never a public admin route. */
export async function runPoolRuntimeOperator(options: Options, accountId: string, signingKey?: string,
  connect?: (configPath: string) => Promise<Platform>) {
  if (!/^[a-f0-9]{32}$/.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID is required");
  const approval = options.restart ? Schema.decodeUnknownSync(Plan)(JSON.parse(await readFile(options.plan, "utf8"))) : undefined;
  if (approval && (approval.accountId !== accountId || approval.worker !== options.worker)) throw new Error("Plan target changed");
  if (approval && (!signingKey || !isSigningKey(signingKey))) throw new Error("POOL_APP_SIGNING_KEY is required");
  const directory = await mkdtemp(join(tmpdir(), "pool-runtime-operator-"));
  let platform: Platform | undefined;
  const receiptPath = `${options.plan}.result.json`;
  try {
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ name: "pool-runtime-operator", account_id: accountId,
      compatibility_date: "2026-09-08", services: [{ binding: "POOL_OPERATIONS", service: options.worker,
        entrypoint: "PoolOperations", remote: true }] }), { mode: 0o600 });
    const open = connect ?? (async (path: string): Promise<Platform> => {
      const { getPlatformProxy } = createRequire(new URL("./startup-profiler/package.json", import.meta.url))("wrangler");
      return getPlatformProxy({ configPath: path, persist: false, remoteBindings: true });
    });
    platform = await open(configPath);
    const operations = platform.env.POOL_OPERATIONS;
    const read = async (id?: string) => {
      const response = await operations.fetch(new Request(
        `http://pool-operations${runtimeRecoveryPath}${id ? `?operationId=${encodeURIComponent(id)}` : ""}`));
      if (!response.ok) throw new Error("Pool recovery inspection failed");
      return response.json();
    };
    if (!approval) {
      const state: unknown = await read();
      const selection = Schema.decodeUnknownSync(Selection)(state);
      const plan = { accountId, worker: options.worker, operationId: crypto.randomUUID(), selection };
      await writeFile(options.plan, JSON.stringify(plan), { mode: 0o600, flag: "wx" });
      return { status: "dry-run", ...plan, state };
    }
    try {
      // The local marker survives a lost response. Repeating the command reads the durable receipt.
      await writeFile(receiptPath, JSON.stringify({ status: "submitted", operationId: approval.operationId }), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      return { status: "inspection", state: await read(approval.operationId) };
    }
    const at = Date.now();
    const envelope = await signEnvelope(signingKey!, runtimeRecoveryPrefix, {
      version: 1, action: "restart", operationId: approval.operationId, ...approval.selection, at, expiresAt: at + 60_000,
    });
    const response = await operations.fetch(new Request(`http://pool-operations${runtimeRecoveryPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope }),
    }));
    if (!response.ok) throw new Error("Restart outcome unavailable; repeat this command only to inspect its receipt");
    const receipt: unknown = await response.json();
    await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    return receipt;
  } finally {
    try { await platform?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); }
  }
}

if (import.meta.main) {
  try {
    const result = await runPoolRuntimeOperator(runtimeOperatorOptions(process.argv.slice(2)),
      process.env.CLOUDFLARE_ACCOUNT_ID ?? "", process.env.POOL_APP_SIGNING_KEY);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (typeof result === "object" && result !== null && "status" in result && result.status === "failed") process.exitCode = 1;
  } catch {
    process.stderr.write("Pool runtime operation failed. Keep the plan and result; repeat only to inspect an uncertain restart.\n");
    process.exitCode = 1;
  }
}
