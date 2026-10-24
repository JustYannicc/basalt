import { PoolAcceptanceClient } from "./pool-acceptance/client.ts";
import { observeRestart } from "./pool-acceptance/restart-observation.ts";
import {
  AcceptanceFailure,
  type Conversation,
  type ModelCatalog,
  type PoolAccess,
  type UsageRecord,
} from "./pool-acceptance/types.ts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { signPoolToken } from "../src/pool/token.ts";

const idleMs = 60 * 60 * 1_000;

export type AcceptanceConfig = {
  readonly apiKey: string;
  readonly poolAccess?: PoolAccess;
  readonly mode: "full" | "restart-observation";
  readonly model?: string;
};

export type AcceptanceHooks = {
  readonly waitForIdle?: () => Promise<number>;
  readonly restart?: typeof observeRestart;
  readonly log?: (message: string) => void;
};

function newConversation(expectedRecords: number): Conversation {
  return { id: crypto.randomUUID().toLowerCase(), expectedRecords };
}

function selectModel(ids: string[], requested?: string): string {
  if (requested) {
    if (!ids.includes(requested)) throw new AcceptanceFailure("The requested model is not present in /v1/models");
    return requested;
  }
  if (ids.length !== 1) {
    throw new AcceptanceFailure(`/v1/models returned ${ids.length} models; set the workflow model input explicitly`);
  }
  return ids[0]!;
}

function assertSameSessionCredential(records: UsageRecord[], label: string): string {
  if (records.length === 0) throw new AcceptanceFailure(`Home returned no usage records for conversation ${label}`);
  const credentialId = records[0]!.account;
  if (records.some((record) => record.account !== credentialId)) {
    throw new AcceptanceFailure("A repeated conversation changed its selected subscription");
  }
  return credentialId;
}

async function waitWithoutRequests(): Promise<number> {
  const started = performance.now();
  while (performance.now() - started < idleMs) {
    await new Promise((done) => setTimeout(done, idleMs - (performance.now() - started)));
  }
  return (performance.now() - started) / 1_000;
}

async function runFullAcceptance(
  client: PoolAcceptanceClient,
  apiKey: string,
  poolAccess: PoolAccess,
  model: string,
  initial: ModelCatalog,
  hooks: AcceptanceHooks,
): Promise<ModelCatalog> {
  const log = hooks.log ?? console.log;
  log("idle_wait status=started seconds=3600 scope=runner_requests deployment_assumption=otherwise_quiet");
  const idleSeconds = await (hooks.waitForIdle ?? waitWithoutRequests)();

  const warm = newConversation(1);
  const first = await client.sendTurn(apiKey, model, warm);
  log(`first_request_after_idle status=200 first_byte_ms=${Math.round(first.firstByteMs)} total_ms=${Math.round(first.totalMs)}`);
  log(`idle_wait status=completed seconds=${Math.floor(idleSeconds)}`);
  if (first.boot !== initial.boot) throw new AcceptanceFailure("Pool boot changed across the idle interval");
  log(`pool_boot status=unchanged idle_seconds=${Math.floor(idleSeconds)}`);

  const a = newConversation(2);
  const b = newConversation(2);
  const c = newConversation(1);
  const d = newConversation(1);
  for (const conversation of [a, b, a, b, c, d]) {
    const result = await client.sendTurn(apiKey, model, conversation);
    if (result.boot !== initial.boot) throw new AcceptanceFailure("Pool boot changed during acceptance requests");
  }

  const conversations = [warm, a, b, c, d];
  const records = await Promise.all(conversations.map((conversation) =>
    client.waitForUsageRecords(poolAccess, conversation)
  ));
  const [, aRecords, bRecords, cRecords, dRecords] = records;
  const accountA = assertSameSessionCredential(aRecords!, "A");
  const accountB = assertSameSessionCredential(bRecords!, "B");
  const accountC = assertSameSessionCredential(cRecords!, "C");
  const accountD = assertSameSessionCredential(dRecords!, "D");
  if (accountA === accountB || accountC === accountD) {
    throw new AcceptanceFailure("New conversations did not spread across both test subscriptions");
  }
  if (new Set(records.flat().map((record) => record.account)).size !== 2) {
    throw new AcceptanceFailure("Acceptance did not exercise exactly two test subscriptions");
  }
  log("usage_records status=200 matched=7 exact_session_filters=5");
  log("affinity status=passed repeated_conversations=2 new_conversations=2 subscriptions=2");

  const restartBaseline = await client.modelCatalog(apiKey);
  if (restartBaseline.boot !== initial.boot) throw new AcceptanceFailure("Pool boot changed before restart observation");
  return restartBaseline;
}

export async function runPoolAcceptance(
  config: AcceptanceConfig,
  options: { readonly client?: PoolAcceptanceClient; readonly hooks?: AcceptanceHooks } = {},
): Promise<void> {
  const client = options.client ?? new PoolAcceptanceClient();
  const hooks = options.hooks ?? {};
  const log = hooks.log ?? console.log;
  if (config.mode === "full" && !config.poolAccess) {
    throw new AcceptanceFailure("Full acceptance requires signed access to the dedicated test pool");
  }

  const initial = await client.modelCatalog(config.apiKey);
  const model = selectModel(initial.ids, config.model);
  log(`models status=200 count=${initial.ids.length}`);

  const baseline = config.mode === "full"
    ? await runFullAcceptance(client, config.apiKey, config.poolAccess!, model, initial, hooks)
    : initial;
  const restart = await (hooks.restart ?? observeRestart)({
    client,
    apiKey: config.apiKey,
    model,
    baseline,
    options: { log },
  });
  const firstStream = await client.sendTurn(config.apiKey, model, newConversation(1));
  if (firstStream.boot !== restart.boot) {
    throw new AcceptanceFailure("Pool boot changed before the first streamed response after restart");
  }
  log(`first_stream_after_restart status=200 first_byte_ms=${Math.round(firstStream.firstByteMs)} total_ms=${Math.round(firstStream.totalMs)}`);
  log(`acceptance status=passed mode=${config.mode}`);
}

function requiredSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AcceptanceFailure(`Required GitHub secret ${name} is missing`);
  return value;
}

async function configFromEnvironment(): Promise<AcceptanceConfig> {
  const apiKey = requiredSecret("POOL_ACCEPTANCE_KEY");
  if (process.env.POOL_ACCEPTANCE_TEST_KEY_CONFIRMED !== "true") {
    throw new AcceptanceFailure("Confirm POOL_ACCEPTANCE_KEY is dedicated to test use");
  }
  const mode = process.env.POOL_ACCEPTANCE_MODE ?? "full";
  if (mode !== "full" && mode !== "restart-observation") {
    throw new AcceptanceFailure("POOL_ACCEPTANCE_MODE must be full or restart-observation");
  }
  let poolAccess: PoolAccess | undefined;
  if (mode === "full") {
    const pool = process.env.POOL_ACCEPTANCE_POOL?.trim();
    if (!pool || !/^acceptance-[a-zA-Z0-9-]+$/.test(pool)) {
      throw new AcceptanceFailure("POOL_ACCEPTANCE_POOL must name a dedicated acceptance-<run> pool");
    }
    poolAccess = {
      token: await signPoolToken(requiredSecret("POOL_APP_SIGNING_KEY"), {
        pool, owner: "acceptance", organization: "acceptance",
      }),
      owner: "acceptance",
    };
  }
  return {
    apiKey,
    poolAccess,
    mode,
    model: process.env.POOL_ACCEPTANCE_MODEL?.trim() || undefined,
  };
}

async function main(): Promise<void> {
  try {
    await runPoolAcceptance(await configFromEnvironment());
  } catch (error) {
    const message = error instanceof AcceptanceFailure ? error.message : "Unexpected acceptance runner failure";
    console.error(`FAIL ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
