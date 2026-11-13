import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { startPoolFixture } from "./pool-fixture.mjs";
import {
  homeMetadataFixture,
  historyMemoryOwnerFixture,
} from "../../scripts/pool-tests/history-fixture.ts";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { poolGroupPrefix } from "../../src/pool/pool-group.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import {
  deliverPoolHistoryChanges,
  readPoolHistorySnapshot,
} from "../../src/pool/model-history/change-revisions.ts";
import { readCommittedPoolChanges, poolChangesPath } from "../../src/pool/change-http.ts";
import { publishPoolChanges } from "../../src/pool/change-revisions.ts";
import { poolUsageOverview, poolPersonalOverview } from "../../src/pool/model-history/overview.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { historyCaller } from "../../src/pool/model-history/http.ts";
import { readRequests } from "../../src/pool/model-history/store.ts";
import { lastSuccessAt } from "../../src/pool/model-history/last-success.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import { CapacityHistory } from "../../src/pool/capacity/history.ts";
import { capacityOverview } from "../../src/pool/capacity/overview.ts";
import { redactLogText } from "../../src/feedback/logs.ts";

/** Synthetic external Home, real SQL history producers/readers, real signed hosted DO delivery. */
export async function startScopedChangeFixture(signingKey, options) {
  const base = await startPoolFixture(signingKey, options);
  const sql = new PGlite();
  const db = {
    query: async (text, values) => {
      const result = await sql.query(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  let queue = Promise.resolve();
  const serial = (work) => {
    const result = queue.then(work);
    queue = result.catch(() => {});
    return result;
  };
  const values = new Map();
  const capacity = new CapacityHistory({
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => {
      values.delete(key);
    },
  });
  try {
    await historyMemoryOwnerFixture(db);
    await homeMetadataFixture(db);
    await sql.exec(`CREATE TABLE channel_group(id bigint PRIMARY KEY,channel_name text,disabled boolean DEFAULT false,deleted_at timestamptz);
    CREATE TABLE channel_group_detail(id bigint PRIMARY KEY,channel_group_id bigint,auth_id text,deleted_at timestamptz);
    CREATE INDEX ON channel_group_detail(auth_id,deleted_at,channel_group_id);
    CREATE TABLE quota_snapshot(credential_id text PRIMARY KEY,expires_at timestamptz,usage_credits jsonb,reset_credits jsonb);
    CREATE TABLE quota_window(credential_id text,window_id text,expires_at timestamptz,reset_at timestamptz);`);
    await migrateModelHistory(db);
  } catch (error) {
    await sql.close();
    await base.stop();
    throw error;
  }
  let productOrigin, initialized;
  let requestSequence = 0;
  let delivered = [];
  const gates = new Map();
  const reads = [],
    failures = [];
  const hold = (kind) => {
    assert.equal(gates.has(kind), false, `only one owned ${kind} response hold`);
    let enter, release;
    const started = new Promise((resolve) => {
      enter = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    const gate = { enter, release, released, claimed: false };
    gates.set(kind, gate);
    return {
      started,
      release() {
        release();
        if (gates.get(kind) === gate) gates.delete(kind);
      },
    };
  };
  const holdResponse = async (kind) => {
    const gate = gates.get(kind);
    if (!gate || gate.claimed) return;
    gate.claimed = true;
    gate.enter();
    await gate.released;
  };
  const publish = (changes) => {
    if (!productOrigin) throw new Error("Scoped fixture has no managed product origin");
    return publishPoolChanges(
      { fetch: (input, init) => fetch(new URL(new URL(input).pathname, productOrigin), init) },
      signingKey,
      changes,
    );
  };
  const drain = async () => {
    const result = await captureHomeRequests(db);
    if (result.pending.length) delivered = result.pending;
    await deliverPoolHistoryChanges(db, result.pending, publish);
    return result.pending;
  };
  const access = { signingKey, permissions: async () => undefined };
  const hostAssertion = async (request, action) => {
    const body = await request.json();
    const value = await openEnvelope(signingKey, "sbs1", body.envelope);
    if (
      !value ||
      value.action !== action ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Date.now() ||
      value.expiresAt > Date.now() + 30_000 ||
      !value.input ||
      value.input.pool !== value.pool ||
      !value.user ||
      !value.organization
    )
      throw new Error("Invalid synthetic boundary host assertion");
    return value;
  };
  const handle = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === poolChangesPath)
      return readCommittedPoolChanges(request, {
        signingKey,
        current: (pool) =>
          serial(async () => {
            const snapshot = await readPoolHistorySnapshot(db, pool);
            return {
              revisions: [
                ...snapshot.revisions,
                ...["pool-samples", "pool-prices"].map((topic) => ({
                  topic,
                  resource: pool,
                  revision: "0",
                })),
              ],
              ...(snapshot.deadline === null ? {} : { validUntil: Date.parse(snapshot.deadline) }),
            };
          }),
      });
    if (url.pathname === "/pool/v1/usage/capacity") {
      const { claims, canManage } = await historyCaller(request, access);
      if (!canManage) return new Response(null, { status: 403 });
      const to = Number(url.searchParams.get("to") ?? Date.now());
      const days = Number(url.searchParams.get("days") ?? 7);
      return Response.json(
        await capacityOverview(
          capacity,
          claims.pool,
          Math.floor((to - days * 86_400_000) / 3_600_000) * 3_600_000,
          to,
        ),
      );
    }
    if (url.pathname === "/pool/v1/usage/history") {
      const { claims, caller, canManage } = await historyCaller(request, access);
      reads.push({ kind: "history", pool: claims.pool });
      const poolHash = (await digest(claims.pool)).slice(0, 16);
      const person = canManage ? undefined : await digest(caller);
      const result = await serial(() =>
        readRequests(db, {
          pool: poolHash,
          from: url.searchParams.get("from"),
          to: url.searchParams.get("to"),
          ...(person === undefined ? {} : { person }),
          ...(url.searchParams.has("after")
            ? { after: JSON.parse(url.searchParams.get("after")) }
            : {}),
        }),
      );
      await holdResponse("history");
      return Response.json(result);
    }
    const action = {
      "/pool/v1/usage/overview": "poolOverview",
      "/pool/v1/usage/personal-overview": "poolPersonalOverview",
      "/pool/v1/usage/series": "poolUsageSeries",
      "/pool/v1/usage/last-success": "lastSuccessAt",
    }[url.pathname];
    if (action) {
      const value = await hostAssertion(request, action);
      reads.push({ kind: action, pool: value.pool });
      const result = await serial(() =>
        action === "poolOverview"
          ? poolUsageOverview(db, { ...value.input, prices: [] })
          : action === "poolPersonalOverview"
            ? poolPersonalOverview(db, value.input, [])
            : action === "lastSuccessAt"
              ? lastSuccessAt(db, value.input, value.authority)
              : poolUsageSeries(db, value.input, value.authority),
      );
      await holdResponse(action);
      return Response.json(result);
    }
    const headers = new Headers(request.headers);
    for (const name of ["host", "connection", "content-length", "transfer-encoding", "keep-alive"])
      headers.delete(name);
    return fetch(new URL(url.pathname + url.search, base.origin), {
      method: request.method,
      headers,
      ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.arrayBuffer() }),
    });
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const response = await handle(
        new Request(new URL(incoming.url, "http://127.0.0.1"), {
          method: incoming.method,
          headers: incoming.headers,
          ...(body.length ? { body } : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      failures.push({
        route: new URL(incoming.url, "http://fixture.invalid").pathname,
        message: redactLogText(String(error)).slice(0, 1000),
      });
      outgoing
        .writeHead(500, { "content-type": "application/json" })
        .end('{"error":"scoped-fixture-failed"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    ...base,
    origin: `http://127.0.0.1:${server.address().port}`,
    product(origin) {
      productOrigin = origin;
      base.product(origin);
    },
    scoped: {
      reads,
      failures,
      engine:
        "PGlite PostgreSQL; production capture/triggers/outbox; signed bridge; hosted native DO",
      holdHistory() {
        return hold("history");
      },
      holdOverview() {
        return hold("poolOverview");
      },
      initialize(pool, person) {
        return serial(async () => {
          initialized = { pool, person, hash: (await digest(pool)).slice(0, 16) };
          await db.query("INSERT INTO channel_group VALUES(1,$1,false,NULL)", [
            poolGroupPrefix + pool,
          ]);
          await db.query(
            "INSERT INTO channel_group_detail VALUES(1,1,'synthetic-scoped-change-codex',NULL)",
          );
          await db.query('INSERT INTO "user" VALUES(1,$1)', [await backendUserName(person, pool)]);
          await db.query("INSERT INTO api_key(id,diagnostic_fingerprint,user_id) VALUES(1,$1,1)", [
            "sha256:" + "a".repeat(64),
          ]);
          await db.query(
            `INSERT INTO basalt_model_history_cursor(source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id)
            VALUES($1,0,0,0,true,0)`,
            [await digest("home-local-v1")],
          );
          await drain();
        });
      },
      commitRequest(model) {
        return serial(async () => {
          assert.ok(initialized, "initialize the actual app mapping first");
          await db.query(
            `INSERT INTO usage(timestamp,request_id,auth_index,provider,model,endpoint,api_key)
            VALUES(now()-interval '2 seconds',$1,'synthetic-scoped-change-codex','codex',$2,'/v1/responses',$3)`,
            [`synthetic-request-${++requestSequence}`, model, "sha256:" + "a".repeat(64)],
          );
          await captureHomeRequests(db);
          const changes = await drain();
          assert.ok(
            changes.some(
              (change) =>
                change.scope === `pool:${initialized.pool}` &&
                change.hint.resource === initialized.pool &&
                change.hint.topic === "pool-usage",
            ),
          );
          return {
            changes,
            model,
            count: requestSequence,
            hash: initialized.hash,
            pool: initialized.pool,
          };
        });
      },
      duplicate() {
        return serial(() => publish(delivered));
      },
      noop() {
        return serial(async () => {
          const before = (await readPoolHistorySnapshot(db, initialized.pool)).revisions;
          const changes = await drain();
          assert.deepEqual(changes, []);
          assert.deepEqual((await readPoolHistorySnapshot(db, initialized.pool)).revisions, before);
        });
      },
    },
    async stop() {
      for (const gate of gates.values()) gate.release();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await queue;
      await sql.close();
      await base.stop();
    },
  };
}
