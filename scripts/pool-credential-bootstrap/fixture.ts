import { runInNewContext } from "node:vm";
import { decodeResult, type BootstrapPlan } from "./contract.ts";
import { bootstrapProgram } from "./program.ts";

export const fixtureNow = 1_900_000_000_000;
export const fixturePlan = (): BootstrapPlan => ({
  version: 1,
  target: {
    operationId: "11111111-1111-4111-8111-111111111111",
    connectionId: "acc_22222222-2222-4222-8222-222222222222",
    accountId: "a".repeat(32),
    storeId: "b".repeat(32),
    stage: "synthetic",
  },
  attemptId: "33333333-3333-4333-8333-333333333333",
  mode: "create",
  tokenId: null,
  expiresAt: fixtureNow + 300_000,
});

interface Token {
  id: string;
  name: string;
  status: string;
  policies: unknown[];
}
interface Secret {
  id: string;
  name: string;
  store_id: string;
  comment: string;
  scopes: string[];
  status: string;
}
interface Request {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
}
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Synthetic object expected");
  return Object.fromEntries(Object.entries(value));
};
const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("Synthetic string expected");
  return value;
};

export function providerFixture(
  options: {
    loseCreateReply?: boolean;
    loseStoreReply?: boolean;
    failStore?: boolean;
    wrongPolicy?: boolean;
    wrongStore?: boolean;
    unboundedInventory?: boolean;
    throwRead?: boolean;
    loseRevokeReply?: boolean;
    loseRotateReply?: boolean;
    failPatch?: boolean;
  } = {},
) {
  const plan = fixturePlan(),
    base = `/accounts/${plan.target.accountId}`;
  const tokens: Token[] = [],
    secrets: Secret[] = [],
    calls: Request[] = [];
  const values = new Map<string, string>();
  const leaked = "synthetic-private-value-must-stay-in-provider";
  let minted = 0,
    rotations = 0,
    now = fixtureNow;
  const envelope = (result: unknown) => ({ success: true, errors: [], result });
  const secretPath = `${base}/secrets_store/stores/${plan.target.storeId}/secrets`;
  const request = async (input: Request) => {
    calls.push(structuredClone(input));
    if (options.throwRead) throw new Error(leaked);
    if (
      input.method === "GET" &&
      input.path === `${base}/secrets_store/stores/${plan.target.storeId}`
    )
      return envelope({
        id: plan.target.storeId,
        account_id: plan.target.accountId,
        name: options.wrongStore ? "foreign" : "default_secrets_store",
      });
    if (input.method === "GET" && input.path === `${base}/tokens`) {
      if (options.unboundedInventory)
        return { ...envelope([]), result_info: { page: input.query?.page, total_pages: 11 } };
      return { ...envelope(tokens), result_info: { page: 1, total_pages: tokens.length ? 1 : 0 } };
    }
    if (input.method === "GET" && input.path === secretPath)
      return {
        ...envelope(secrets),
        result_info: { page: 1, total_pages: secrets.length ? 1 : 0 },
      };
    if (input.method === "POST" && input.path === `${base}/tokens`) {
      const body = record(input.body);
      const token: Token = {
        id: (++minted).toString(16).padStart(32, "0"),
        name: text(body.name),
        status: "active",
        policies: Array.isArray(body.policies) ? structuredClone(body.policies) : [],
      };
      tokens.push(token);
      if (options.loseCreateReply) throw new Error(leaked);
      return envelope({ ...structuredClone(token), value: leaked });
    }
    const token = tokens.find((row) => input.path.startsWith(`${base}/tokens/${row.id}`));
    if (token) {
      if (input.method === "GET")
        return envelope({
          ...structuredClone(token),
          ...(options.wrongPolicy ? { policies: [] } : {}),
        });
      if (input.method === "DELETE") {
        tokens.splice(tokens.indexOf(token), 1);
        if (options.loseRevokeReply) throw new Error(leaked);
        return envelope({ id: token.id });
      }
      if (input.method === "PUT" && input.path.endsWith("/value")) {
        const value = leaked + "-rotation-" + ++rotations;
        if (options.loseRotateReply) throw new Error(leaked);
        return envelope(value);
      }
    }
    if (input.path === secretPath && input.method === "POST") {
      if (options.failStore) throw new Error(leaked);
      if (!Array.isArray(input.body) || input.body.length !== 1)
        throw new Error("Synthetic single secret expected");
      const body = record(input.body[0]);
      const secret: Secret = {
        id: "c".repeat(32),
        name: text(body.name),
        store_id: plan.target.storeId,
        comment: text(body.comment),
        scopes: ["workers"],
        status: "active",
      };
      secrets.push(secret);
      values.set(secret.id, text(body.value));
      if (options.loseStoreReply) throw new Error(leaked);
      return envelope(structuredClone([secret]));
    }
    const secret = secrets.find((row) => input.path === `${secretPath}/${row.id}`);
    if (secret && input.method === "PATCH") {
      if (options.failPatch) throw new Error(leaked);
      const body = record(input.body);
      values.set(secret.id, text(body.value));
      return envelope(structuredClone(secret));
    }
    throw new Error("Unexpected synthetic request");
  };
  return {
    tokens,
    secrets,
    calls,
    values,
    leaked,
    get minted() {
      return minted;
    },
    get rotations() {
      return rotations;
    },
    set now(value: number) {
      now = value;
    },
    async run(input = plan, account = plan.target.accountId) {
      const execute: unknown = runInNewContext(`(${bootstrapProgram(input)})`, {
        cloudflare: { request },
        accountId: account,
        Date: class extends Date {
          static now() {
            return now;
          }
        },
      });
      if (typeof execute !== "function") throw new Error("Synthetic program is not callable");
      const result: unknown = await execute();
      return decodeResult(result);
    },
  };
}
