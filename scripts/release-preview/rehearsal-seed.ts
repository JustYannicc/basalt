import { createHash, randomUUID } from "node:crypto";
import { PreviewClient } from "../pool-acceptance/preview-client.ts";
import type { PreviewSavedAccount } from "../pool-acceptance/preview-pool.ts";
import { AcceptanceFailure, isObject } from "../pool-acceptance/types.ts";

/** Dirty, empty policies once broke a release; the rehearsal carries one ready pool beside six. */
export const rehearsalDirtyPolicyCount = 6;
// The preview smoke's own pool must stay empty until the smoke runs, so it is one of the six.
export const rehearsalEmptyPoolCount = rehearsalDirtyPolicyCount - 1;

export interface RehearsalSeedInput {
  readonly origin: string;
  readonly email: string;
  readonly password: string;
  readonly organizationId: string;
  /** The preview seed's pool. It is left empty for the preview smoke. */
  readonly poolAppId: string;
  /** The stage's saved provider accounts, as written to the acceptance accounts file. */
  readonly accounts: readonly PreviewSavedAccount[];
  /** No subscription accounts: the clean pool stays account-less and no traffic computer is claimed. */
  readonly infraOnly?: boolean;
  readonly emptyCount?: number;
  readonly fetch?: typeof fetch;
}

/** Model access to the clean pool through a claimed computer. Revoke `computerId` when done. */
export interface RehearsalPoolAccess {
  readonly computerId: string;
  readonly modelUrl: string;
  readonly modelKey: string;
}

export interface RehearsalSeed {
  /** The executor app id. PoolWorker keys policies by it and the availability target names it. */
  readonly cleanPool: string;
  readonly emptyPools: readonly string[];
  /** Absent for an infra-only seed, which claims no traffic computer. */
  readonly access?: RehearsalPoolAccess;
}

export interface RehearsalPolicy {
  readonly pool: string;
  readonly organization: string;
  readonly revision: number;
  readonly expiresAt: number;
  readonly accounts: readonly string[];
  readonly dirty: boolean;
}

export class RehearsalRefusal extends Error {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    super(`Rehearsal pool policies refused: ${reasons.join("; ")}`);
    this.reasons = reasons;
  }
}

// Names must not match the preview seed's `<user>'s pool N` lookup, or a reseed could adopt one.
export const rehearsalPoolName = (index: number) =>
  index === 0 ? "Rehearsal clean pool" : `Rehearsal empty pool ${index}`;

/**
 * The host replays a known request id with the same name instead of creating another app, so a
 * retried job converges on the same pools. Pool creation only accepts a v4-shaped UUID.
 */
export function rehearsalRequestId(organizationId: string, index: number): string {
  const bytes = createHash("sha256")
    .update(`basalt-release-rehearsal-pool:${organizationId}:${index}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function requireAccounts(accounts: readonly PreviewSavedAccount[]) {
  const requirements = accounts.map((account) => account.requirement).sort();
  if (
    JSON.stringify(requirements) !== JSON.stringify(["anthropic", "openai"]) ||
    !accounts.every((account) => /^acc_[A-Za-z0-9_-]+$/.test(account.id))
  )
    throw new AcceptanceFailure("Rehearsal needs the stage's OpenAI and Anthropic accounts");
}

async function createPool(client: PreviewClient, organizationId: string, index: number) {
  const { http } = client;
  const response = await http.request(
    `/api/organizations/${encodeURIComponent(organizationId)}/pools`,
    {
      method: "POST",
      headers: http.headers({ Origin: http.origin, "Content-Type": "application/json" }),
      body: http.encodeJson(
        {
          name: rehearsalPoolName(index),
          requestId: rehearsalRequestId(organizationId, index),
          newInstance: true,
        },
        "Rehearsal pool creation request",
      ),
    },
    "Rehearsal pool creation",
  );
  await http.expectOk(response, "Rehearsal pool creation");
  const app = await http.readJson(response, "Rehearsal pool creation");
  if (!isObject(app) || typeof app.id !== "string" || !/^app_[A-Za-z0-9_-]+$/.test(app.id))
    throw new AcceptanceFailure("Rehearsal pool creation did not return an app id");
  return app.id;
}

/**
 * Creates, as the smoke user and through the product routes, `emptyCount` pools that stay empty
 * and one pool holding both stage accounts, then claims a computer on that clean pool.
 */
export async function seedRehearsalPools(input: RehearsalSeedInput): Promise<RehearsalSeed> {
  const emptyCount = input.emptyCount ?? rehearsalEmptyPoolCount;
  if (!Number.isSafeInteger(emptyCount) || emptyCount < 0 || emptyCount > 20)
    throw new AcceptanceFailure("Rehearsal empty pool count must be between 0 and 20");
  if (!input.infraOnly) requireAccounts(input.accounts);
  else if (input.accounts.length)
    throw new AcceptanceFailure("An infra-only seed takes no accounts");
  const preview = new PreviewClient(input, { fetch: input.fetch });
  await preview.signIn();
  try {
    // The preview smoke refuses a non-empty pool, so a seed that touched it must fail here.
    await preview.verifyEmptyPool();
    const pools: string[] = [];
    for (let index = 0; index <= emptyCount; index += 1) {
      const id = await createPool(preview, input.organizationId, index);
      // A replay of this run's own request is fine; landing on the preview pool or a sibling is not.
      if (id === input.poolAppId || pools.includes(id))
        throw new AcceptanceFailure("Rehearsal pool creation reused an existing pool");
      pools.push(id);
    }
    const [cleanPool, ...emptyPools] = pools as [string, ...string[]];
    if (input.infraOnly) return { cleanPool, emptyPools };
    const clean = new PreviewClient({ ...input, poolAppId: cleanPool }, { fetch: input.fetch });
    await clean.signIn();
    try {
      for (const account of input.accounts) await clean.selectAccount(account);
      await clean.waitForPoolAccounts(input.accounts.length);
      const computer = await clean.claimComputer(`Rehearsal traffic ${randomUUID().slice(0, 8)}`);
      const { modelUrl, modelKey } = computer.payload.credentials;
      return { cleanPool, emptyPools, access: { computerId: computer.id, modelUrl, modelKey } };
    } finally {
      await clean.signOut();
    }
  } finally {
    await preview.signOut();
  }
}

/** Refuses unless the controller holds exactly the production-shaped policy set. */
export function verifyRehearsalPolicies(
  policies: readonly RehearsalPolicy[],
  expected: {
    readonly cleanPool: string;
    readonly emptyPools?: readonly string[];
    /** An infra-only seed adds no accounts: its clean pool must hold none, not some. */
    readonly infraOnly?: boolean;
  },
): void {
  const reasons: string[] = [];
  const total = rehearsalDirtyPolicyCount + 1;
  if (policies.length !== total)
    reasons.push(`expected ${total} policies, found ${policies.length}`);
  if (new Set(policies.map((policy) => policy.pool)).size !== policies.length)
    reasons.push("a pool has more than one policy");
  const organizations = new Set(policies.map((policy) => policy.organization));
  if (organizations.size !== 1)
    reasons.push(`expected one organization, found ${organizations.size}`);
  const clean = policies.filter((policy) => policy.pool === expected.cleanPool);
  if (clean.length !== 1) reasons.push("the clean pool has no policy");
  for (const policy of clean) {
    if (policy.dirty) reasons.push("the clean pool is dirty");
    if (expected.infraOnly) {
      if (policy.accounts.length !== 0) reasons.push("the infra-only clean pool has accounts");
    } else if (policy.accounts.length === 0) reasons.push("the clean pool has no accounts");
  }
  const others = policies.filter((policy) => policy.pool !== expected.cleanPool);
  for (const policy of others) {
    if (!policy.dirty) reasons.push(`${policy.pool} is not dirty`);
    if (policy.accounts.length !== 0) reasons.push(`${policy.pool} has accounts`);
  }
  if (expected.emptyPools) {
    const wanted = [...expected.emptyPools].sort();
    const actual = others.map((policy) => policy.pool).sort();
    if (JSON.stringify(wanted) !== JSON.stringify(actual))
      reasons.push("the dirty policies are not the seeded pools");
  }
  if (reasons.length) throw new RehearsalRefusal(reasons);
}
