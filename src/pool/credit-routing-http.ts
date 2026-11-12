import type { AccountUsageRouting } from "../../apps/pool/usage-credits-contract.ts";
import type { HomeClient } from "./control.ts";
import { poolCreditRouting, setPoolCreditPolicy } from "./credit-policy.ts";
import { fail, failureResponse, json, object, readBody } from "./json.ts";
import { openEnvelope } from "./token.ts";
import { setPoolSelectionPolicy } from "./selection-policy.ts";

export const creditRoutingPaths = new Set([
  "/pool/v1/accountRouting",
  "/pool/v1/setCreditPolicy",
  "/pool/v1/setSelectionPolicy",
]);
const rank = (value: AccountUsageRouting) =>
  !value.eligible ? 3 : value.use === "plan" ? 0 : value.use === "credits" ? 1 : 2;

/** Only the host supplies inspected account mappings and owner authority. */
export async function handleCreditRouting(
  request: Request,
  access: {
    home: HomeClient;
    signingKey: string;
    previousSigningKey?: string;
    ensure?: (pool: string, organization: string) => Promise<void>;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const bytes = await readBody(request, 262_144);
    if (bytes === undefined)
      return fail(413, "invalid_query", "The policy assertion exceeds its limit.");
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const payload =
      object(body) && typeof body.envelope === "string"
        ? await openEnvelope(access.signingKey, "sbs1", body.envelope, access.previousSigningKey)
        : undefined;
    const path = new URL(request.url).pathname;
    if (!creditRoutingPaths.has(path))
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const action = path.slice("/pool/v1/".length);
    if (
      !object(payload) ||
      payload.action !== action ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + 30_000 ||
      typeof payload.pool !== "string" ||
      !payload.pool ||
      typeof payload.organization !== "string" ||
      !payload.organization ||
      typeof payload.user !== "string" ||
      !payload.user ||
      typeof payload.owner !== "string" ||
      !payload.owner
    )
      return fail(401, "unauthorized", "A valid host policy assertion is required.");
    if (action !== "accountRouting" && payload.user !== payload.owner)
      return fail(403, "not_owner", "Only the pool owner can change routing policy.");
    await access.ensure?.(payload.pool, payload.organization);
    if (action === "setCreditPolicy")
      return json(await setPoolCreditPolicy(access.home, payload.pool, payload.usageCreditPolicy));
    if (action === "setSelectionPolicy")
      return json(
        await setPoolSelectionPolicy(access.home, payload.pool, payload.accountSelectionPolicy),
      );
    if (
      typeof payload.canEdit !== "boolean" ||
      payload.canEdit !== (payload.owner === payload.user) ||
      !Array.isArray(payload.accounts) ||
      payload.accounts.length > 500
    )
      return fail(400, "invalid_query", "A bounded inspected account mapping is required.");
    const result = await poolCreditRouting(access.home, payload.pool);
    const accounts: Record<string, AccountUsageRouting> = {};
    for (const entry of payload.accounts) {
      if (
        !object(entry) ||
        typeof entry.account !== "string" ||
        !entry.account ||
        !Array.isArray(entry.home) ||
        entry.home.length === 0 ||
        entry.home.length > 32 ||
        !entry.home.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
      )
        return fail(400, "invalid_query", "A valid inspected account mapping is required.");
      const available = entry.home.flatMap((id) =>
        typeof id === "string" && result.accounts[id] ? [result.accounts[id]!] : [],
      );
      available.sort((a, b) => rank(a) - rank(b));
      const first = available[0];
      if (first !== undefined) accounts[entry.account] = first;
    }
    return json({
      usageCreditPolicy: result.usageCreditPolicy,
      accountSelectionPolicy: result.accountSelectionPolicy,
      canEdit: payload.canEdit,
      accounts,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
