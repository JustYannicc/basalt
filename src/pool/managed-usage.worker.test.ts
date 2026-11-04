import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { handleRequest, type RouterEnv } from "../router.ts";
import { fixture, member, owner, pool, signingKey } from "./test/computers.ts";
import { signEnvelope, signPoolToken } from "./token.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return {
      url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
      shortCircuit: true,
    };
    if (specifier === "pg") return {
      url: "data:text/javascript,export default { Client: class {} }",
      shortCircuit: true,
    };
    return next(specifier, context);
  },
});
const workerModule = "./worker.ts";
const { PoolContainer, default: poolWorker }: {
  PoolContainer: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response> };
  default: { fetch(request: Request, env: object): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

test("public managed usage and cap routes require signed host authority and keep setup private", async () => {
  let reads = 0, writes = 0;
  const f = fixture({
    summary: async (target, recordedOwner, caller, days, members) => {
      assert.deepEqual([target, recordedOwner, caller, days, members], [pool.pool, owner, "admin", 30, [member]]);
      reads++;
      return { from: "2026-01-01", to: "2026-01-31", readAt: null, members: [{ member }], accounts: [{ account: "private" }] } as never;
    },
    setCap: async (target, recordedOwner, person, weekly) => {
      assert.deepEqual([target, recordedOwner, person, weekly], [pool.pool, owner, member, 5]);
      writes++;
    },
  });
  const worker = new PoolContainer({ container: {}, storage: f.storage, id: { toString: () => "fixture" } }, {
    POOL_DATABASE_URL: "postgres://fixture", POOL_MANAGEMENT_KEY: "fixture",
    POOL_APP_SIGNING_KEY: signingKey, POOL_IMAGE_HASH: "fixture",
  });
  // Only the usage backend is synthetic; exercise the real Router, Worker and signed handler.
  Object.defineProperty(worker, "computers", { value: { handle: f.setup } });
  const poolEnv = { PoolContainer: { jurisdiction: () => ({ getByName: () => worker }) } };
  const env: RouterEnv = {
    CATALOG_SERVICE: { fetch: async () => { throw Error("usage reached catalog"); } },
    TOOLS_SERVICE: { fetch: async () => { throw Error("usage reached tools"); } },
    POOL_SERVICE: { fetch: (request) => poolWorker.fetch(request, poolEnv) },
    POOL_APP_SIGNING_KEY: signingKey,
  };
  const send = (path: string, envelope: string, method = "POST") => handleRequest(new Request(`https://${brand.host}${path}`, {
    method, ...(method === "GET" ? {} : { body: JSON.stringify({ envelope }) }),
  }), env);
  const token = await signPoolToken(signingKey, pool);
  for (const action of ["managed-usage", "managed-cap"]) {
    const path = `/pool/v1/${action}`;
    const payload = { action, pool: pool.pool, owner, organization: pool.organization, user: "admin",
      members: [member], member, weekly: 5, expiresAt: f.now() + 10_000 };
    for (const envelope of ["", token,
      await signEnvelope("ef".repeat(32), "sbs1", payload),
      await signEnvelope(signingKey, "sbs1", { ...payload, action: "claim" }),
      await signEnvelope(signingKey, "sbs1", { ...payload, expiresAt: f.now() }),
    ]) assert.equal((await send(path, envelope)).status, 401);
    assert.deepEqual([reads, writes], action === "managed-usage" ? [0, 0] : [1, 0]);
    const envelope = await signEnvelope(signingKey, "sbs1", payload);
    assert.equal((await send(`/__setup/v1/${action}`, envelope)).status, 404);
    const response = await send(path, envelope);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await send(path, envelope, "GET")).status, 404);
    const view = await response.json();
    if (action === "managed-usage") {
      assert.deepEqual(view.members, [{ member }]);
      assert.equal("accounts" in view, false);
    } else assert.deepEqual(view, { success: true });
  }
  assert.deepEqual([reads, writes], [1, 1]);
  assert.deepEqual(f.server.calls, []);
});
