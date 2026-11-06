import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { accessPath, accessPrefix, accessTtl } from "./access-contract.ts";
import {
  membershipPath,
  membershipPrefix,
  membershipReadPrefix,
  policyPrefix,
} from "./membership-contract.ts";
import { openEnvelope, signEnvelope, signPoolToken } from "./token.ts";
import type { PoolView } from "../../apps/pool/contract.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query() { return { rows: [{ active: false }] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const workerModule = "./worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (ctx: object, env: object) => { fetch(request: Request): Promise<Response> };
} = await import(workerModule);
hooks.deregister();

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const signingKey = "ab".repeat(32),
  pool = "snapshot-pool",
  owner = "snapshot-owner",
  member = "snapshot-member";
const claims = { pool, owner, organization: "snapshot-organization" };
const observed = "2026-11-01T10:00:00.000Z";

async function fixture() {
  const values = new Map<string, unknown>();
  const reads: string[] = [],
    background: Promise<unknown>[] = [];
  let members = ["retained-account", "revoked-account"];
  let nativeAccounts = [...members];
  let hold: { entered: ReturnType<typeof gate>; release: ReturnType<typeof gate> } | undefined;
  const audience = {
    ...claims,
    name: "Pool",
    users: [owner, member],
    managers: [owner, member],
    authorization: "executor-app-v1",
    ownerSource: "audience",
    pending: [],
    provisioned: [member],
    at: Date.now() - 1,
  };
  values.set("pool-directory-v1", {
    pools: { [JSON.stringify(pool)]: audience },
    refusals: {},
    people: {},
    refusalsVersion: 2,
  });
  values.set(`pool-account-removals:${pool}`, {
    since: null,
    items: [{ account: "removed-history", actor: owner, at: observed }],
  });
  const runtime = {
    running: false,
    start() {
      this.running = true;
    },
    destroy: async () => {
      runtime.running = false;
    },
    setInactivityTimeout: async () => {},
    getTcpPort(port: number) {
      return {
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init),
            url = new URL(request.url);
          if (port === 8318) {
            if (url.pathname === "/native-policy") {
              const { projection } = (await request.json()) as { projection: string };
              const policy = (await openEnvelope(signingKey, policyPrefix, projection)) as {
                revision: number;
              };
              return Response.json({ installed: true, revision: policy.revision });
            }
            return Response.json({ boot_id: "snapshot-boot", started_at: observed });
          }
          assert.equal(port, 8327);
          assert.equal(request.headers.get("X-Management-Key"), "snapshot-management-key");
          const path = url.pathname.slice("/v8/management".length);
          if (request.method === "DELETE" && path.startsWith("/channel-group-details/")) {
            members = members.filter((_id, index) => index + 1 !== Number(path.split("/").at(-1)));
            return Response.json({});
          }
          assert.equal(request.method, "GET");
          let response: Response;
          if (path === "/channel-groups")
            response = Response.json({
              channel_groups: [{ id: 1, channel_name: `signalbox-pool-${pool}` }],
            });
          else if (path === "/channel-group-details")
            response = Response.json({
              channel_group_details: members.map((id, index) => ({
                id: index + 1,
                channel_group_id: 1,
                auth_id: id,
              })),
            });
          else if (path === "/credentials")
            response = Response.json({
              files: [...members, "another-pool-account"].map((id) => ({
                id,
                provider: "codex",
                label: id,
              })),
            });
          else if (path.startsWith("/quota/credentials/"))
            response = Response.json({
              credential: {
                credential_id: path.split("/").at(-1),
                observed_at: observed,
                freshness: "fresh",
              },
              windows: [],
            });
          else throw new Error(`Unexpected Home request ${path}`);
          const pending = hold;
          if (pending) {
            pending.entered.resolve();
            await pending.release.promise;
          }
          return response;
        },
      };
    },
  };
  const worker = new PoolContainer(
    {
      container: runtime,
      waitUntil: (work: Promise<unknown>) => {
        background.push(work);
      },
      storage: {
        get: async (key: string) => {
          reads.push(key);
          return structuredClone(values.get(key));
        },
        put: async (key: string, value: unknown) => {
          values.set(key, structuredClone(value));
        },
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    },
    {
      POOL_DATABASE_URL: "postgres://snapshot:fixture@database.invalid/snapshot",
      POOL_MANAGEMENT_KEY: "snapshot-management-key",
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_IMAGE_HASH: "snapshot-image",
      TOOLS_SERVICE: {
        fetch: async (_url: string, init: RequestInit) => {
          if (new URL(_url).pathname === "/api/internal/pool-organization")
            return new Response(null, { status: 204 });
          const { envelope } = JSON.parse(String(init.body)) as { envelope: string };
          const assertion = await openEnvelope(signingKey, membershipReadPrefix, envelope);
          assert.deepEqual(
            Object.fromEntries(
              Object.entries(assertion as object).filter(([key]) =>
                ["pool", "organization"].includes(key),
              ),
            ),
            { pool, organization: claims.organization },
          );
          return Response.json({
            pool,
            organization: claims.organization,
            native: true,
            accounts: nativeAccounts.map((id) => ({
              account: id,
              requirement: "subscriptions",
              provider: "codex",
              method: "codex",
              generation: 1,
              driver: null,
              driverRevision: null,
              bindingRevision: null,
              homeReference: id,
            })),
          });
        },
      },
    },
  );
  const token = await signPoolToken(signingKey, claims);
  const view = (caller: string, fresh = false) =>
    worker.fetch(
      new Request(`https://pool.example/pool/v1/pool${fresh ? "?fresh=true" : ""}`, {
        headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": caller },
      }),
    );
  const drain = async () => {
    for (let i = 0; i < background.length; i++) await background[i];
  };
  const holdHome = () => {
    assert.equal(hold, undefined);
    const pending = { entered: gate(), release: gate() };
    hold = pending;
    return {
      started: pending.entered.promise,
      release: () => {
        hold = undefined;
        pending.release.resolve();
      },
    };
  };
  const changeAudience = async (users: string[], managers: string[]) => {
    const now = Date.now();
    const envelope = await signEnvelope(signingKey, accessPrefix, {
      action: "audience",
      at: now,
      expiresAt: now + accessTtl,
      pools: [{ ...claims, name: "Pool", authorization: "executor-app-v1", users, managers }],
    });
    const response = await worker.fetch(
      new Request(`https://pool.example${accessPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
    assert.equal(response.status, 200, await response.clone().text());
  };
  const revokeAccount = async () => {
    nativeAccounts = ["retained-account"];
    const now = Date.now();
    const envelope = await signEnvelope(signingKey, membershipPrefix, {
      pool,
      organization: claims.organization,
      at: now,
      expiresAt: now + 30_000,
    });
    const response = await worker.fetch(
      new Request(`https://pool.example${membershipPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
    assert.equal(response.status, 204, await response.clone().text());
  };
  return { values, reads, view, holdHome, changeAudience, revokeAccount, drain };
}

async function body(response: Response): Promise<PoolView> {
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as PoolView;
}
function fieldSets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(fieldSets);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, fieldSets(item)]),
    );
  return typeof value;
}

test("a removed member is refused at the Worker gate before a populated snapshot is read", async () => {
  const f = await fixture();
  await body(await f.view(owner));
  const held = f.holdHome();
  try {
    assert.equal((await body(await f.view(member))).reading?.source, "snapshot");
    await held.started;
    await f.changeAudience([owner], [owner]);
    const reads = f.reads.filter((key) => key.startsWith("pool-view-")).length;
    const cached = await f.view(member),
      fresh = await f.view(member, true);
    assert.equal(cached.status, 403);
    assert.equal(fresh.status, 403);
    assert.deepEqual(await cached.json(), await fresh.json());
    assert.equal(f.reads.filter((key) => key.startsWith("pool-view-")).length, reads);
  } finally {
    held.release();
    await f.drain();
  }
});

test("a downgraded non-owner gets identical filtered field sets from snapshot and live views", async () => {
  const f = await fixture();
  const ownerView = await body(await f.view(owner));
  assert.ok(ownerView.removals?.items.length);
  const before = await body(await f.view(member, true));
  await f.changeAudience([owner, member], [owner]);
  const held = f.holdHome();
  let snapshot: PoolView;
  try {
    snapshot = await body(await f.view(member));
    await held.started;
    assert.equal(snapshot.reading?.source, "snapshot");
    assert.equal(snapshot.isOwner, false);
    assert.equal("removals" in snapshot, false);
    assert.deepEqual(fieldSets(snapshot), fieldSets(before));
    assert.deepEqual(
      snapshot.accounts.map((account) => account.id),
      ["retained-account", "revoked-account"],
    );
  } finally {
    held.release();
    await f.drain();
  }
  const live = await body(await f.view(member, true));
  assert.equal(live.reading?.source, "live");
  assert.deepEqual(fieldSets(snapshot), fieldSets(live));
});

test("a native account revocation fences a saved view and its in-flight revalidation", async () => {
  const f = await fixture();
  await body(await f.view(owner));
  const held = f.holdHome();
  try {
    const before = await body(await f.view(member));
    await held.started;
    assert.ok(before.accounts.some((account) => account.id === "revoked-account"));
    await f.revokeAccount();
  } finally {
    held.release();
    await f.drain();
  }
  const live = await body(await f.view(member, true));
  assert.deepEqual(
    live.accounts.map((account) => account.id),
    ["retained-account"],
  );
  const next = f.holdHome();
  try {
    const snapshot = await body(await f.view(member));
    await next.started;
    assert.equal(snapshot.reading?.source, "snapshot");
    assert.deepEqual(
      snapshot.accounts.map((account) => account.id),
      ["retained-account"],
    );
    assert.deepEqual(fieldSets(snapshot), fieldSets(live));
    assert.equal(snapshot.isOwner, false);
    assert.equal("removals" in snapshot, false);
  } finally {
    next.release();
    await f.drain();
  }
});
