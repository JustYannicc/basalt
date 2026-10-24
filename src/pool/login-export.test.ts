import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolControl, type ControlStorage } from "./attribution.ts";
import { signPoolToken } from "./token.ts";

const signingKey = "ab".repeat(32);
const pool = "app_2b344d97-fbcb-42e4-99fb-70ad88adf740";
const id = "76e6ac6e-e34f-4b27-9df1-514cbcf61216";
const foreignId = "c5852a31-6f93-4c5a-8f61-70a77a26b621";
const owner = "fixture-owner";
const organization = "fixture-organization";
const path = `/accounts/${id}/export?provider=claude`;
type Row = Record<string, unknown>;

async function fixture(provider = "claude") {
  const state = {
    groups: [{ id: 1, channel_name: `signalbox-pool-${pool}` }, { id: 2, channel_name: "signalbox-pool-other" }],
    members: [{ id: 1, channel_group_id: 1, auth_id: id }, { id: 2, channel_group_id: 2, auth_id: foreignId }],
    files: [{ id, provider, type: provider }, { id: foreignId, provider, type: provider }] as Row[],
    raw: ` { "type": "${provider}", "access_token": "fixture-secret", "nested": { "preserve": true } }\n`,
    download: undefined as (() => Response | Promise<Response>) | undefined,
    storageAccesses: 0,
  };
  const calls: { path: string; init?: RequestInit }[] = [];
  const home = async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    assert.equal(init?.method ?? "GET", "GET", "Export must never mutate Home");
    if (path === "/v8/management/channel-groups") return Response.json({ channel_groups: state.groups });
    if (path === "/v8/management/channel-group-details") return Response.json({ channel_group_details: state.members });
    if (path.startsWith("/v8/management/channel-group-details?")) {
      const group = Number(new URL(`https://home.invalid${path}`).searchParams.get("channel_group_id"));
      return Response.json({ channel_group_details: state.members.filter((member) => member.channel_group_id === group) });
    }
    if (path.startsWith("/v8/management/quota/credentials?")) return Response.json({ items: [] });
    if (path === "/v8/management/credentials") return Response.json({ files: state.files });
    if (path === `/v8/management/credentials/download?id=${id}`) {
      assert.equal(init?.redirect, "error");
      return state.download ? state.download() : new Response(state.raw, { headers: { "X-Private-Home-Header": "fixture-private" } });
    }
    throw new Error("Unexpected fixture Home request");
  };
  const touchedStorage = async (): Promise<never> => { state.storageAccesses++; throw new Error("Export must not access attribution storage"); };
  const storage: ControlStorage = { get: touchedStorage, put: touchedStorage, getAlarm: touchedStorage, setAlarm: touchedStorage };
  const control = new PoolControl(storage, { signingKey, home });
  const token = await signPoolToken(signingKey, { pool, owner, organization });
  async function call(route = path, options: { token?: string | null; caller?: string | null; method?: string } = {}) {
    const headers = new Headers();
    const bearer = options.token === undefined ? token : options.token;
    const caller = options.caller === undefined ? owner : options.caller;
    if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
    if (caller !== null) headers.set("x-signalbox-caller", caller);
    const response = await control.handle(new Request(`https://pool.invalid/pool/v1${route}`, { headers, method: options.method }));
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(state.storageAccesses, 0);
    return response;
  }
  return { state, calls, call, token };
}

async function error(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  const value = await response.json() as Row;
  assert.equal(value.error, code);
  assert.deepEqual(Object.keys(value).sort(), ["error", "message"]);
  assert.doesNotMatch(JSON.stringify(value), /fixture-secret|fixture-private/);
}
function downloads(calls: { path: string }[]) { return calls.filter((call) => call.path.includes("/credentials/download")); }

for (const provider of ["claude", "codex"]) {
  test(`owner exports the exact ${provider} login file from a native opaque pool id without storage writes`, async () => {
    const f = await fixture(provider);
    const response = await f.call(`/accounts/${id}/export?provider=${provider}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("X-Private-Home-Header"), null);
    assert.equal(await response.text(), f.state.raw);
    assert.equal(downloads(f.calls).length, 1);
    assert.equal(f.calls.filter((call) => call.path === "/v8/management/channel-groups").length, 2);
  });
}

test("export rejects missing, invalid, and tampered tokens and non-owner callers before Home", async () => {
  const f = await fixture();
  const parts = f.token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ pool: "other", owner, organization })).toString("base64url");
  for (const token of [null, "fake", parts.join(".")]) await error(await f.call(path, { token }), 401, "unauthorized");
  for (const caller of [null, "other-owner"]) await error(await f.call(path, { caller }), 403, "not_owner");
  assert.equal(f.calls.length, 0);
});

test("export scopes membership to the signed pool and matches the canonical account id only", async () => {
  const f = await fixture();
  const otherToken = await signPoolToken(signingKey, { pool: "other", owner, organization });
  await error(await f.call(path, { token: otherToken }), 404, "not_found");
  await error(await f.call(`/accounts/${foreignId}/export?provider=claude`), 404, "not_found");
  f.state.files[0]!.auth_index = "credential-alias";
  await error(await f.call("/accounts/credential-alias/export?provider=claude"), 404, "not_found");
  assert.equal(downloads(f.calls).length, 0);
});

test("export refreshes group ownership instead of trusting cached group ids", async () => {
  const f = await fixture();
  assert.equal((await f.call("/pool")).status, 200);
  f.state.groups[0]!.channel_name = "signalbox-pool-renamed";
  await error(await f.call(), 404, "not_found");
  assert.equal(downloads(f.calls).length, 0);
});

test("export validates narrow selectors before Home", async () => {
  const f = await fixture();
  for (const route of [
    `/accounts/${id}/export`, `/accounts/${id}/export?provider=antigravity`,
    `/accounts/${id}/export?provider=claude&provider=codex`,
    `/accounts/${id}/export?provider=claude&name=other`,
    `/accounts/${id}/export?provider=claude&id=${foreignId}`,
    "/accounts/%00/export?provider=claude", "/accounts/%2F/export?provider=claude",
    "/accounts/%5C/export?provider=claude", "/accounts/%ZZ/export?provider=claude",
    "/accounts/%20/export?provider=claude",
  ]) await error(await f.call(route), 400, "invalid_query");
  await error(await f.call(path, { method: "POST" }), 404, "not_found");
  await error(await f.call(`${path.replace("/export?", "/export/extra?")}`), 404, "not_found");
  assert.equal(f.calls.length, 0);
});

test("export checks exact metadata provider and rejects missing or ambiguous credentials before download", async () => {
  const f = await fixture();
  f.state.files[0]!.provider = "codex";
  await error(await f.call(), 404, "not_found");
  f.state.files[0]!.provider = "claude";
  f.state.files[0]!.type = "codex";
  await error(await f.call(), 404, "not_found");
  f.state.files[0]!.type = "claude";
  f.state.files.push({ ...f.state.files[0] });
  await error(await f.call(), 503, "backend_unavailable");
  f.state.files = [];
  await error(await f.call(), 404, "not_found");
  assert.equal(downloads(f.calls).length, 0);
});

test("export rejects membership removal during download without releasing the file", async () => {
  const f = await fixture();
  f.state.download = () => {
    f.state.members = [];
    return new Response(f.state.raw);
  };
  await error(await f.call(), 404, "not_found");
  assert.equal(downloads(f.calls).length, 1);
});

test("export sanitizes all Home download errors and does not forward redirects", async () => {
  const f = await fixture();
  for (const status of [302, 400, 401, 403, 404, 429, 500]) {
    f.state.download = () => new Response("fixture-secret", { status, headers: { Location: "https://elsewhere.invalid/fixture-private" } });
    await error(await f.call(), status === 404 ? 404 : 503, status === 404 ? "not_found" : "backend_unavailable");
  }
  f.state.download = () => { throw new Error("fixture-secret"); };
  await error(await f.call(), 503, "backend_unavailable");
});

test("export rejects malformed, non-object, and wrong-provider files without reflecting their contents", async () => {
  const f = await fixture();
  for (const raw of ["fixture-secret", "null", "[]", "{}", '{"type":"codex","secret":"fixture-secret"}']) {
    f.state.download = () => new Response(raw);
    await error(await f.call(), 503, "backend_unavailable");
  }
  f.state.download = () => new Response(new Uint8Array([0xff]));
  await error(await f.call(), 503, "backend_unavailable");
  f.state.download = () => new Response(null, { status: 204 });
  await error(await f.call(), 503, "backend_unavailable");
});

test("export bounds streamed files to 1 MiB and cancels an oversized response", async () => {
  const f = await fixture();
  let canceled = false;
  f.state.download = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(512 * 1024));
      controller.enqueue(new Uint8Array(512 * 1024 + 1));
    },
    cancel() { canceled = true; },
  }));
  await error(await f.call(), 503, "backend_unavailable");
  assert.equal(canceled, true);
  f.state.raw = JSON.stringify({ type: "claude", padding: "x".repeat(1024 * 1024 - 30) });
  assert.equal(Buffer.byteLength(f.state.raw), 1024 * 1024);
  f.state.download = undefined;
  const response = await f.call();
  assert.equal(response.status, 200);
  assert.equal(await response.text(), f.state.raw);
});
