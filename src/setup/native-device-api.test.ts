import assert from "node:assert/strict";
import { test } from "node:test";
import { deviceCode, DeviceApprovalError, readDevicePools, readDeviceRequest, reviewDeviceDecision } from "./native-device-api.ts";

const origin = "https://app.fixture.invalid";
const signal = () => new AbortController().signal;
const selection = { name: "Test computer", pool: "shared-pool", models: true, tools: true };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
type Call = { url: URL; input: RequestInit };

function fixture(override?: (call: Call) => Response | undefined | Promise<Response | undefined>) {
  const calls: Call[] = [];
  const previousFetch = globalThis.fetch;
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin } });
  globalThis.fetch = async (path, input = {}) => {
    const call = { url: new URL(String(path), origin), input };
    calls.push(call);
    const response = await override?.(call);
    if (response) return response;
    switch (call.url.pathname) {
      case "/api/auth/get-session": return json({ user: { id: "person-1", email: "person@example.invalid", emailVerified: true } });
      case "/api/auth/device/request": return json({ clientId: "native-client", resource: `${origin}/native`, scopes: ["native", "offline_access"] });
      case "/api/auth/oauth2/public-client": return json({ client_name: "Registered client" });
      case "/setup/v1/context": return json({ intent: "fresh-intent" });
      case "/setup/v1/computers": return json({ pools: [{ id: "shared-pool", name: "Shared", mine: false }, { id: "own-pool", name: "Own", mine: true }] });
      case "/api/auth/device/decide": return json({ status: JSON.parse(String(input.body)).accept ? "approved" : "denied" });
      default: throw new Error(`Unexpected URL ${call.url.pathname}`);
    }
  };
  return {
    calls,
    [Symbol.dispose]() {
      globalThis.fetch = previousFetch;
      if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation);
      else Reflect.deleteProperty(globalThis, "location");
    },
  };
}
const decisionCalls = (calls: Call[]) => calls.filter((call) => call.url.pathname === "/api/auth/device/decide");

test("device codes accept the protocol alphabet and separators without accepting URL input", () => {
  assert.equal(deviceCode("bcdf ghjk"), "BCDF-GHJK");
  for (const value of ["ABCD-GHJK", "BCDF-1234", "BCDF-GHJK-extra", "https://example.invalid", ""]) assert.equal(deviceCode(value), undefined);
});

test("native approval refuses a different audience and wider scopes before any decision", async () => {
  for (const pending of [
    { resource: "https://other.invalid/native", scopes: ["native"] },
    { resource: `${origin}/mcp`, scopes: ["native"] },
    { resource: `${origin}/native`, scopes: ["native", "executor"] },
    { resource: `${origin}/native`, scopes: ["offline_access"] },
  ]) {
    using f = fixture(({ url }) => url.pathname === "/api/auth/device/request" ? json({ clientId: "client", ...pending }) : undefined);
    await assert.rejects(readDeviceRequest("BCDF-GHJK", signal()), /not a native device request/);
    assert.equal(decisionCalls(f.calls).length, 0);
  }
});

test("approval uses a fresh intent and the selected shared pool while retaining explicit tool access", async () => {
  using f = fixture();
  const original = await readDeviceRequest("BCDF-GHJK", signal());
  const result = await reviewDeviceDecision("BCDF-GHJK", original, signal(), { ...selection, models: false });
  assert.deepEqual(result, { kind: "decided", status: "approved" });
  const decision = decisionCalls(f.calls);
  assert.equal(decision.length, 1);
  const headers = new Headers(decision[0]!.input.headers);
  assert.equal(headers.get("x-basalt-native-intent"), "fresh-intent");
  assert.equal(headers.get("x-basalt-native-pool"), "shared-pool");
  assert.equal(headers.get("x-basalt-native-models"), "false");
  assert.equal(headers.get("x-basalt-native-tools"), "true");
  assert.equal(headers.has("authorization"), false);
  assert.equal(f.calls.find((call) => call.url.pathname === "/setup/v1/computers")!.url.searchParams.get("intent"), "fresh-intent");
  for (const call of f.calls) {
    assert.equal(call.url.origin, origin);
    assert.equal(call.input.credentials, "same-origin");
    assert.equal(call.input.redirect, "error");
    assert.equal(call.input.cache, "no-store");
  }
});

test("a changed account or removed pool requires another review and sends no decision", async () => {
  for (const change of ["account", "pool"] as const) {
    let changed = false;
    using f = fixture(({ url }) => changed && change === "account" && url.pathname === "/api/auth/get-session"
      ? json({ user: { id: "person-2", email: "other@example.invalid", emailVerified: true } })
      : changed && change === "pool" && url.pathname === "/setup/v1/computers"
        ? json({ pools: [{ id: "own-pool", name: "Own", mine: true }] }) : undefined);
    const original = await readDeviceRequest("BCDF-GHJK", signal());
    changed = true;
    const result = await reviewDeviceDecision("BCDF-GHJK", original, signal(), selection);
    assert.equal(result.kind, "review");
    assert.equal(decisionCalls(f.calls).length, 0);
  }
});

test("denial works while setup is unavailable and never mints or sends a setup intent", async () => {
  using f = fixture(({ url }) => url.pathname.startsWith("/setup/") ? json({}, 503) : undefined);
  const original = await readDeviceRequest("BCDF-GHJK", signal());
  await assert.rejects(readDevicePools(signal()), /Could not load your pools/);
  const before = f.calls.length;
  assert.deepEqual(await reviewDeviceDecision("BCDF-GHJK", original, signal()), { kind: "decided", status: "denied" });
  assert.equal(f.calls.slice(before).some((call) => call.url.pathname.startsWith("/setup/")), false);
  assert.equal(new Headers(decisionCalls(f.calls)[0]!.input.headers).has("x-basalt-native-intent"), false);
});

test("an unconfirmed decision is never retried or reported as approved", async () => {
  for (const failure of ["network", "server", "invalid", "different"] as const) {
    using f = fixture(({ url }) => {
      if (url.pathname !== "/api/auth/device/decide") return;
      if (failure === "network") throw new Error("Network disappeared after receiving the write");
      return failure === "server" ? json({ message: "private backend details" }, 502)
        : failure === "different" ? json({ status: "denied" }) : json({ status: "anything" });
    });
    const original = await readDeviceRequest("BCDF-GHJK", signal());
    await assert.rejects(reviewDeviceDecision("BCDF-GHJK", original, signal(), selection), (error: unknown) =>
      error instanceof DeviceApprovalError && error.kind === "uncertain" && !error.message.includes("private backend"));
    assert.equal(decisionCalls(f.calls).length, 1);
  }
});

test("signed-out, expired and previously decided requests stay actionable", async () => {
  for (const status of [401, 404, 409]) {
    using f = fixture(({ url }) => url.pathname === "/api/auth/device/request" ? json({}, status) : undefined);
    await assert.rejects(readDeviceRequest("BCDF-GHJK", signal()), (error: unknown) => error instanceof DeviceApprovalError &&
      error.kind === (status === 401 ? "signed-out" : "request"));
    assert.equal(decisionCalls(f.calls).length, 0);
  }
});
