import { appendFileSync } from "node:fs";
import { imageDigest } from "../scripts/scale-test/settings.ts";

const rows = {
  "containers/applications": [{ id: "fixture-app", name: "basalt-180-scale-pool", account_id: "private-account-sentinel", configuration: { image: "private-production-image-sentinel" } },
    { id: "foreign-app", name: "production-pool" }],
  "workers/scripts": [],
  "workers/durable_objects/namespaces": [],
  "storage/kv/namespaces": [],
  "hyperdrive/configs": [{ id: "fixture-drive", name: "basalt-180-scale-auth", origin: { host: "private-database-host-sentinel", user: "private-role-sentinel" } }],
  "mtls_certificates": [{ id: "fixture-ca", name: "basalt-180-scale-ca" }],
};
let database = true;
if (process.env.SCALE_FIXTURE_NEWER_LEASE === "true") rows["workers/scripts"].push({ id: "basalt-180-scale-gateway" });
globalThis.fetch = async (target, init = {}) => {
  const url = new URL(target);
  const method = init.method ?? "GET";
  const record = { host: url.hostname, path: url.pathname, method };
  appendFileSync(process.env.SCALE_FIXTURE_CALLS, JSON.stringify(record) + "\n");
  const response = (body, status = 200) => Response.json(body, { status });
  if (url.hostname === "api.planetscale.com") {
    if (!url.pathname.endsWith("/databases/basalt-180-scale-pg")) throw new Error("Unscoped database operation");
    if (method === "DELETE") { database = false; return response({}); }
    return database ? response({ name: "basalt-180-scale-pg", private: "private-database-sentinel" }) : response({}, 404);
  }
  if (url.hostname !== "api.cloudflare.com") throw new Error("Unexpected provider");
  const path = url.pathname.replace(/^\/client\/v4\/accounts\/[^/]+\//, "");
  if (path.endsWith("/settings") && process.env.SCALE_FIXTURE_RUN === "true") return response({ result: { bindings: [
    { name: "TEST_DEADLINE", text: String(Date.now() + 2 * 60 * 60_000) },
    { name: "TEST_ORIGIN", text: "https://basalt-180-scale-gateway.fixture.workers.dev" },
    { name: "POOL_IMAGE_HASH", text: `fixture-image@${imageDigest}` },
  ] } });
  if (path.endsWith("/settings")) return process.env.SCALE_FIXTURE_NEWER_LEASE === "true"
    ? response({ result: { bindings: [{ name: "TEST_DEADLINE", text: "9999999999999" }] } }) : response({}, 404);
  if (method === "DELETE") {
    const entry = Object.entries(rows).find(([kind]) => path.startsWith(`${kind}/`));
    if (!entry) throw new Error("Unexpected delete");
    const [kind, values] = entry;
    const id = path.slice(kind.length + 1);
    if (id === "foreign-app") throw new Error("Foreign resource deletion attempted");
    rows[kind] = values.filter((row) => row.id !== id);
    return response({ success: true });
  }
  if (!(path in rows)) throw new Error("Unexpected provider request");
  return response({ success: true, result: rows[path] });
};
