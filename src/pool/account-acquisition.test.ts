import assert from "node:assert/strict";
import test from "node:test";
import { HomeAccountAcquisitions } from "./account-acquisition.ts";
import { accountAcquisitionPath, accountAcquisitionPrefix } from "./account-acquisition-contract.ts";
import { HomeClient } from "./control.ts";
import { homeReferences } from "./home-references.ts";
import { object } from "./json.ts";
import { signEnvelope } from "./token.ts";

const key = "22".repeat(32);
const owner = "organization:fixture";

function fixture(existing: readonly string[] = []) {
  const retained = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    async get<T>(name: string): Promise<T | undefined> { return structuredClone(retained.get(name)) as T | undefined; },
    async put(name: string, value: unknown) { retained.set(name, structuredClone(value)); },
    async getAlarm() { return alarm; },
    async setAlarm(at: number) { alarm = at; },
  };
  const calls: { path: string; method: string }[] = [];
  const credentials = new Set(existing);
  const members = new Set<string>();
  let status: Record<string, unknown> = { status: "wait" };
  let failStart = false;
  const home = new HomeClient(async (path, init) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    const url = new URL(path, "https://fixture.invalid");
    if (url.pathname.endsWith("/oauth/auth-url")) {
      if (failStart) throw new Error("Lost response after send");
      return Response.json({ state: "home-state", url: "https://provider.invalid/device", user_code: "CODE" });
    }
    if (url.pathname.endsWith("/oauth/status")) return Response.json(status);
    if (url.pathname.endsWith("/oauth/session")) return Response.json({ cancelled: true });
    if (url.pathname.endsWith("/credentials")) {
      if (method === "DELETE") { credentials.delete(url.searchParams.get("id") ?? ""); return Response.json(null); }
      return Response.json({ files: [...credentials].map((id) => ({ id, provider: "gemini-cli" })) });
    }
    if (url.pathname.endsWith("/channel-groups")) return Response.json({ channel_groups: [{ id: 1, channel_name: "signalbox-pool-pool" }] });
    if (url.pathname.endsWith("/channel-group-details"))
      return Response.json({ channel_group_details: [...members].map((auth_id, index) => ({ id: index + 1, auth_id, channel_group_id: 1 })) });
    throw new Error(`Unexpected Home request: ${method} ${url.pathname}`);
  });
  const markers = new Set<string>();
  const excluded = new Set<string>();
  const attribution = {
    async begin() { const id = crypto.randomUUID(); markers.add(id); return id; },
    async settle(id: string, ids: readonly string[]) { markers.delete(id); for (const ref of ids) excluded.add(ref); },
  };
  const make = () => new HomeAccountAcquisitions(storage, home, key, attribution);
  let controller = make();
  return {
    calls, credentials, members, markers, excluded,
    restart() { controller = make(); },
    complete(ids: readonly string[]) { for (const id of ids) credentials.add(id); status = { status: "ok", auth_ids: ids }; },
    loseStart() { failStart = true; },
    async send(action: string, input: Record<string, unknown> = {}, principal = owner, operation = "connect:start") {
      const at = Date.now();
      const envelope = await signEnvelope(key, accountAcquisitionPrefix, {
        owner: principal, provider: "gemini-cli", operation, action, at, expiresAt: at + 30_000, ...input,
      });
      return controller.handle(new Request(`https://pool.invalid${accountAcquisitionPath}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ envelope }),
      }));
    },
    unsigned: () => controller.handle(new Request(`https://pool.invalid${accountAcquisitionPath}`, { method: "POST", body: "{}" })),
  };
}

async function body(response: Response) {
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(object(value));
  return value;
}

test("a global sign-in retains exact project IDs across restart without attaching a pool", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  assert.equal(typeof started.session, "string");
  assert.deepEqual(await body(await f.send("start")), started);
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  f.complete(["parent", "project-a", "project-b"]);
  const connected = await body(await f.send("status", { session: started.session }));
  assert.equal(connected.state, "connected");
  assert.equal(typeof connected.ref, "string");
  assert.deepEqual(homeReferences(String(connected.ref)), ["parent", "project-a", "project-b"]);
  assert.equal(f.markers.size, 0);
  assert.deepEqual([...f.excluded].sort(), ["parent", "project-a", "project-b"]);
  assert.equal(f.calls.some((call) => call.method === "POST" && call.path.includes("channel-group")), false);
  f.restart();
  const before = f.calls.length;
  assert.deepEqual(await body(await f.send("status", { session: started.session })), connected);
  assert.equal(f.calls.length, before);
  assert.equal((await f.send("status", { session: started.session }, "organization:another")).status, 503);
});

test("an unsigned request cannot warm Home or mutate acquisition state", async () => {
  const f = fixture();
  assert.equal((await f.unsigned()).status, 403);
  assert.equal(f.calls.length, 0);
  assert.equal(f.markers.size, 0);
});

test("an uncertain start is retained and never repeated after eviction", async () => {
  const f = fixture();
  f.loseStart();
  assert.equal((await f.send("start")).status, 503);
  f.restart();
  assert.equal((await f.send("start")).status, 503);
  assert.equal(f.calls.filter((call) => call.path.includes("/oauth/auth-url")).length, 1);
  assert.equal(f.markers.size, 1);
});

test("a new connection cannot claim a credential that existed before sign-in", async () => {
  const f = fixture(["saved"]);
  const started = await body(await f.send("start"));
  f.complete(["saved"]);
  const failed = await body(await f.send("status", { session: started.session }));
  assert.equal(failed.state, "failed");
  await f.send("cancel", { session: started.session });
  assert.deepEqual([...f.credentials], ["saved"]);
  assert.equal(f.calls.some((call) => call.method === "DELETE" && call.path.includes("credentials")), false);
});

test("failed-save cancellation retires only fresh credentials and preserves a reconnect", async () => {
  const f = fixture(["saved"]);
  const started = await body(await f.send("start", { reconnect: "saved" }));
  f.complete(["saved", "fresh"]);
  assert.equal((await body(await f.send("status", { session: started.session }))).state, "connected");
  assert.equal((await f.send("cancel", { session: started.session })).status, 200);
  assert.deepEqual([...f.credentials], ["saved"]);
  assert.equal(f.calls.filter((call) => call.method === "DELETE" && call.path.includes("credentials")).length, 1);
});

test("cancellation refuses to delete a credential already linked to a pool", async () => {
  const f = fixture();
  const started = await body(await f.send("start"));
  f.complete(["fresh"]);
  await f.send("status", { session: started.session });
  f.members.add("fresh");
  assert.equal((await f.send("cancel", { session: started.session })).status, 503);
  assert.deepEqual([...f.credentials], ["fresh"]);
});
