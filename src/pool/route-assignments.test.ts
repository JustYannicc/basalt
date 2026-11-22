import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import {
  accountMirrorPath,
  accountMirrorPrefix,
  handleAccountKeyMirror,
} from "./account-key-mirror.ts";
import {
  RouteAssignments,
  credentialProxy,
  routeProxyUrl,
  unassignedRoute,
  type RouteResolution,
  type RouteResolver,
  type RouteStorage,
} from "./route-assignments.ts";
import { signEnvelope } from "./token.ts";
import mirrorRoutes from "./account-mirror-route.fixture.json" with { type: "json" };

const signingKey = "cd".repeat(32);
const now = 1_800_000_000_000;
const mine = "12345678-abcd-4000-8000-00000000000a";
const teammate = "12345678-abcd-4000-8000-00000000000b";
const oauth = "12345678-abcd-4000-8000-00000000000c";
const home = "rt_" + "h".repeat(26);
const other = "rt_" + "o".repeat(26);
const owner = "org/example/user/owner";
const mate = "org/example/user/mate";

function storage(): RouteStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) =>
      new Map(
        [...map].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)]),
      ),
  };
}

/** Home's management surface as the pool uses it: one API-key family, OAuth files, the config. */
function fakeHome() {
  const state = {
    codex: [] as Record<string, unknown>[],
    files: [] as Record<string, unknown>[],
    global: "",
    failFields: false,
    writes: [] as string[],
  };
  const client = new HomeClient(async (path, init) => {
    const route = path.replace("/v8/management", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (route.startsWith("/config/api-keys/")) {
      if (route !== "/config/api-keys/codex") return new Response(null, { status: 404 });
      if (method === "PUT") {
        state.writes.push("codex");
        state.codex = body;
        return Response.json({ status: "ok" });
      }
      return Response.json(state.codex);
    }
    if (route === "/credentials" && method === "GET") return Response.json({ files: state.files });
    if (route === "/credentials" && method === "POST") {
      state.files.push({ id: body.uuid, proxy_url: body.proxy_url ?? "" });
      return Response.json({ status: "ok", name: `${body.uuid}.json` });
    }
    if (route === "/credentials/fields" && method === "PATCH" && state.failFields)
      return new Response(null, { status: 500 });
    if (route === "/credentials/fields" && method === "PATCH") {
      const file = state.files.find((item) => item.id === body.id);
      if (!file) return Response.json({ error: "not_found" }, { status: 404 });
      state.writes.push(`auth:${body.id}`);
      file.proxy_url = body.proxy_url;
      return Response.json({ status: "ok" });
    }
    if (route === "/config" && method === "PATCH") {
      state.writes.push("global");
      state.global = body.requests["proxy-url"];
      return Response.json({ status: "ok" });
    }
    if (route === "/config") return Response.json({ requests: { "proxy-url": state.global } });
    return new Response(null, { status: 404 });
  });
  const keyProxy = (reference: string) =>
    state.codex
      .flatMap((group) => group.keys as Record<string, unknown>[])
      .find((key) => key.id === reference)?.["proxy-url"] ?? "";
  return { client, state, keyProxy };
}

const scope = { organization: "example-organization", pool: "example-pool" };

function scripted(initial: Record<string, RouteResolution>) {
  let table = { ...initial };
  let revision = 1;
  let failing = false;
  let served = true;
  const calls: number[] = [];
  const resolver: RouteResolver = {
    resolve: async (_scope, references) => {
      calls.push(references.length);
      if (failing) throw new Error("synthetic outage");
      return {
        served,
        revision: served ? revision : 0,
        resolutions: new Map(
          references.map((reference) => [
            reference,
            (served && table[reference]) || { routeId: null, owner: null },
          ]),
        ),
      };
    },
  };
  return {
    resolver,
    calls,
    set(next: Record<string, RouteResolution>) {
      table = { ...table, ...next };
      revision++;
    },
    fail(value: boolean) {
      failing = value;
    },
    serve(value: boolean) {
      served = value;
    },
  };
}

async function mirror(
  home: HomeClient,
  routes: RouteAssignments,
  reference: string,
  credential: Record<string, unknown>,
  hint: Record<string, unknown> = {},
) {
  const envelope = await signEnvelope(signingKey, accountMirrorPrefix, {
    at: now,
    expiresAt: now + 10_000,
    reference,
    action: "upsert",
    credential,
    ...hint,
  });
  return handleAccountKeyMirror(
    new Request(`https://pool.example${accountMirrorPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    { home, signingKey, now: () => now, routes },
  );
}
const apiKey = {
  type: "config",
  family: "codex",
  group: { "base-url": "https://models.example.test/v1" },
  token: "synthetic",
};
const claude = { type: "claude", access_token: "synthetic" };
const signal = () => AbortSignal.timeout(5_000);
const refreshFloor = 15 * 60_000;

test("a pool member is routed before the pool may serve it, and re-mirrors keep the route", async () => {
  const { client, keyProxy, state } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner }, [oauth]: { routeId: home, owner } });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  assert.equal((await mirror(client, routes, mine, apiKey)).status, 200);
  assert.equal((await mirror(client, routes, oauth, claude)).status, 200);
  // No pool is known here yet, so there is nothing to ask: nothing names a route.
  assert.equal(keyProxy(mine), "");
  await routes.prepare(scope, [mine, oauth], signal());
  assert.equal(keyProxy(mine), `socks5://${home}:x@127.0.0.1:20990`);
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(home));
  assert.equal((await mirror(client, routes, mine, apiKey)).status, 200);
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(await routes.routeOwner(home), owner);
  assert.equal(await routes.routeOwner(other), null);
  // An unchanged membership resolves nothing again.
  const before = rules.calls.length;
  await routes.prepare(scope, [oauth, mine], signal());
  assert.equal(rules.calls.length, before);
});

test("a failed resolve in the membership step holds only new members whose owner has rules, and never fails the step", async () => {
  const { client, keyProxy, state } = fakeHome();
  const warm = "12345678-abcd-4000-8000-00000000000e";
  const rules = scripted({});
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, warm, apiKey);
  await routes.prepare(scope, [warm], signal());
  // Not yet a member anywhere the tools service knows: an owner with rules waits.
  await mirror(client, routes, mine, apiKey, { hasRules: true });
  assert.equal(keyProxy(mine), routeProxyUrl(unassignedRoute));
  await mirror(client, routes, teammate, apiKey, { hasRules: false });
  rules.set({ [mine]: { routeId: home, owner } });
  rules.fail(true);
  await routes.prepare(scope, [warm, mine, teammate], signal());
  assert.equal(keyProxy(mine), routeProxyUrl(unassignedRoute));
  assert.equal(keyProxy(teammate), "");
  rules.fail(false);
  await routes.prepare(scope, [warm, mine, teammate], signal());
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(keyProxy(teammate), "");
  // After rules were served, an owner with rules is retried by the host; anyone else is not touched.
  rules.fail(true);
  state.writes.length = 0;
  assert.equal((await mirror(client, routes, mine, apiKey, { hasRules: true })).status, 503);
  assert.deepEqual(state.writes, []);
  const calls = rules.calls.length;
  assert.equal((await mirror(client, routes, teammate, apiKey, { hasRules: false })).status, 200);
  assert.equal(rules.calls.length, calls);
  assert.equal(keyProxy(mine), routeProxyUrl(home));
});

test("no route rules anywhere: a new unclaimed credential is mirrored, refreshed and served exactly as on main", async () => {
  for (const served of [false, true]) {
    const { client, state } = fakeHome();
    // Served or not, no rule routes anything.
    const rules = scripted({});
    rules.serve(served);
    const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
    await routes.prepare(scope, [], signal());
    await routes.refresh(signal());
    for (const hint of [{}, { hasRules: false }]) {
      const calls = rules.calls.length;
      assert.equal((await mirror(client, routes, mine, apiKey, hint)).status, 200);
      assert.equal((await mirror(client, routes, oauth, claude, hint)).status, 200);
      // No resolve call before it can serve, and Home holds exactly what main writes.
      assert.equal(rules.calls.length, calls);
      const key = state.codex
        .flatMap((group) => group.keys as Record<string, unknown>[])
        .find((item) => item.id === mine)!;
      assert.deepEqual(Object.keys(key).sort(), ["api-key", "id"]);
      assert.equal(state.files.find((file) => file.id === oauth)!.proxy_url, "");
    }
    state.writes.length = 0;
    await routes.prepare(scope, [mine, oauth], signal());
    await routes.refresh(signal());
    assert.deepEqual(state.writes, []);
  }
});

test("an unreachable tools service that never answered 200 leaves everything direct: no hold and no 503", async () => {
  const { client, keyProxy, state } = fakeHome();
  const rules = scripted({});
  rules.fail(true);
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await routes.prepare(scope, [], signal());
  for (const hint of [{}, { hasRules: false }, { hasRules: true }]) {
    assert.equal((await mirror(client, routes, mine, apiKey, hint)).status, 200);
    assert.equal(keyProxy(mine), "");
  }
  assert.equal((await mirror(client, routes, oauth, claude, { hasRules: true })).status, 200);
  await routes.prepare(scope, [mine, oauth], signal());
  await routes.tick(signal());
  assert.equal(keyProxy(mine), "");
  assert.equal(state.files[0]!.proxy_url, "");
});

test("rule changes rewrite only the credentials whose route changed, and a failed pass changes nothing", async () => {
  const { client, state, keyProxy } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner } });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, teammate, apiKey);
  await routes.prepare(scope, [mine, teammate], signal());
  await routes.refresh(signal());
  state.writes.length = 0;
  await routes.tick(signal());
  assert.deepEqual(state.writes, []);
  rules.set({ [mine]: { routeId: null, owner: null } });
  rules.fail(true);
  await assert.rejects(routes.tick(signal()));
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(await routes.routeOwner(home), owner);
  rules.fail(false);
  await routes.tick(signal());
  assert.equal(keyProxy(mine), "");
  assert.equal(keyProxy(teammate), "");
  assert.deepEqual(state.writes, ["codex"]);
  assert.equal(await routes.routeOwner(home), null);
});

test("in a Home where every credential is routed, a teammate's new credential gets no proxy and the global is never written", async () => {
  const { client, state, keyProxy } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner }, [oauth]: { routeId: home, owner } });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, oauth, claude);
  await routes.prepare(scope, [mine, oauth], signal());
  await routes.refresh(signal());
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  // Home creates an acquired credential itself, without the mirror: it must inherit nothing.
  state.files.push({ id: teammate, proxy_url: "" });
  await routes.refresh(signal());
  await routes.prepare(scope, [mine, oauth, teammate], signal());
  assert.equal(state.files.find((file) => file.id === teammate)!.proxy_url, "");
  assert.equal(state.global, "");
  assert.ok(!state.writes.includes("global"));
  assert.equal(await routes.routeOwner(home), owner);
});

test("a malformed route never becomes direct, and one failing write doesn't stop the others", async () => {
  const { client, keyProxy, state } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner }, [oauth]: { routeId: home, owner } });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await routes.prepare(scope, [], signal());
  await routes.refresh(signal());
  assert.equal(
    (
      await mirror(client, routes, mine, apiKey, {
        hasRules: true,
        route: { routeId: "rt_../x", owner },
      })
    ).status,
    503,
  );
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, oauth, claude);
  // Home refuses the OAuth record's write: the API key is still routed, and the pass fails.
  state.failFields = true;
  await assert.rejects(routes.prepare(scope, [mine, oauth], signal()));
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(state.files.find((file) => file.id === oauth)!.proxy_url, "");
  // The next membership pass retries them, and Home takes the write this time.
  state.failFields = false;
  await routes.prepare(scope, [mine, oauth], signal());
  assert.equal(state.files.find((file) => file.id === oauth)!.proxy_url, routeProxyUrl(home));
});

test("credentials under different owners' routes keep their own owners; a clash refuses that route", async () => {
  const { client } = fakeHome();
  const rules = scripted({
    [mine]: { routeId: home, owner },
    [teammate]: { routeId: other, owner: mate },
  });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, teammate, apiKey);
  await routes.prepare(scope, [mine, teammate], signal());
  assert.equal(await routes.routeOwner(home), owner);
  assert.equal(await routes.routeOwner(other), mate);
  rules.set({ [teammate]: { routeId: home, owner: mate } });
  await routes.refresh(signal());
  assert.equal(await routes.routeOwner(home), null);
});

test("404 means no route rules only until rules were served once; after that it is a failure", async () => {
  const { client, keyProxy } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner } });
  rules.serve(false);
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, mine, apiKey);
  await routes.prepare(scope, [mine], signal());
  assert.equal(keyProxy(mine), "");
  rules.serve(true);
  await routes.refresh(signal());
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  rules.serve(false);
  await assert.rejects(routes.refresh(signal()));
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal((await mirror(client, routes, mine, apiKey, { hasRules: true })).status, 503);
  // A host without hints re-mirrors it and the assigned route stays.
  assert.equal((await mirror(client, routes, mine, apiKey)).status, 200);
  assert.equal(keyProxy(mine), routeProxyUrl(home));
});

test("only a credential whose owner has rules is held; the host's route is written at once; a teammate without rules is never held", async () => {
  const { client, keyProxy, state } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner } });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await routes.prepare(scope, [mine], signal());
  await routes.refresh(signal());
  // Home refreshes OAuth credentials before any membership step: the host's own answer routes it.
  await mirror(client, routes, oauth, claude, { hasRules: true, route: { routeId: home, owner } });
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(home));
  assert.equal(await routes.routeOwner(home), owner);
  // The host decided direct at the account and everything levels: no hold.
  await mirror(client, routes, teammate, apiKey, { hasRules: true, route: null });
  assert.equal(keyProxy(teammate), "");
  // A pool-app rule could route it, so the host omits route: held until its membership step.
  await mirror(client, routes, teammate, apiKey, { hasRules: true });
  assert.equal(keyProxy(teammate), routeProxyUrl(unassignedRoute));
  assert.equal(await routes.routeOwner(unassignedRoute), null);
  // A full pass leaves it blocked; its membership step decides.
  await routes.refresh(signal());
  assert.equal(keyProxy(teammate), routeProxyUrl(unassignedRoute));
  await routes.prepare(scope, [mine, oauth, teammate], signal());
  assert.equal(keyProxy(teammate), "");
  // In the same pool, someone without rules, or a host that sends no hint, keeps today's behaviour.
  const stranger = "12345678-abcd-4000-8000-00000000000d";
  await mirror(client, routes, stranger, apiKey, { hasRules: false });
  assert.equal(keyProxy(stranger), "");
  await mirror(client, routes, stranger, apiKey);
  assert.equal(keyProxy(stranger), "");
  rules.fail(true);
  await routes.prepare(scope, [mine, oauth, teammate, stranger], signal());
  assert.equal(keyProxy(stranger), "");
});

test("a 404 after a 200 keeps the last values even across a controller restart", async () => {
  const { client, keyProxy } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner } });
  const store = storage();
  const before = new RouteAssignments(store, rules.resolver, client, () => now);
  await mirror(client, before, mine, apiKey);
  await before.prepare(scope, [mine], signal());
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  // A new isolate: only the durable storage survives.
  const restarted = new RouteAssignments(store, rules.resolver, client, () => now + refreshFloor);
  rules.serve(false);
  await assert.rejects(restarted.tick(signal()));
  await assert.rejects(restarted.refresh(signal()));
  assert.equal((await mirror(client, restarted, mine, apiKey, { hasRules: true })).status, 503);
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(await restarted.routeOwner(home), owner);
});

test("the host's two mirror fields give the outcomes in the fixture P4a builds to", async () => {
  for (const vector of mirrorRoutes.cases) {
    const { client, keyProxy } = fakeHome();
    const rules = scripted({});
    const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
    await routes.prepare(scope, [], signal());
    await routes.refresh(signal());
    const calls = rules.calls.length;
    assert.equal(
      (await mirror(client, routes, mine, apiKey, vector.fields)).status,
      200,
      vector.name,
    );
    const expected = {
      routed: routeProxyUrl(mirrorRoutes.routeId),
      direct: "",
      held: routeProxyUrl(unassignedRoute),
    }[vector.pool];
    assert.equal(keyProxy(mine), expected, vector.name);
    assert.equal(rules.calls.length > calls, vector.resolveCalls, vector.name);
  }
});

test("the pool view finds the caller's own route by account order, never a teammate's", async () => {
  const { client } = fakeHome();
  const rules = scripted({
    [mine]: { routeId: home, owner },
    [teammate]: { routeId: other, owner: mate },
  });
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, teammate, apiKey);
  await routes.prepare(scope, [mine, teammate], signal());
  assert.equal(await routes.ownRoute(owner, [teammate, mine]), home);
  assert.equal(await routes.ownRoute(mate, [mine, teammate]), other);
  assert.equal(
    await routes.ownRoute("org/example-organization/user/someone-else", [mine, teammate]),
    null,
  );
});

test("a 200 that leaves a reference out, before any good answer, still means direct", async () => {
  const { client, keyProxy } = fakeHome();
  const partial: RouteResolver = {
    resolve: async () => ({ served: true, revision: 3, resolutions: new Map() }),
  };
  const routes = new RouteAssignments(storage(), partial, client, () => now);
  await routes.prepare(scope, [mine], signal());
  assert.equal((await mirror(client, routes, mine, apiKey, { hasRules: true })).status, 200);
  assert.equal(keyProxy(mine), "");
});

test("the owner check knows a routed sign-in's route during its exchange and keeps it on what it saved", async () => {
  const { client } = fakeHome();
  const routes = new RouteAssignments(storage(), scripted({}).resolver, client, () => now);
  assert.equal(await routes.routeOwner(home), null);
  await routes.beginSignIn("session-1", { routeId: home, owner });
  assert.equal(await routes.routeOwner(home), owner);
  await routes.settleSignIn("session-1", [mine]);
  assert.equal(await routes.routeOwner(home), owner);
  assert.equal(await routes.ownRoute(owner, [mine]), home);
  // A failed sign-in saved nothing, so its route no longer vouches for anyone.
  await routes.beginSignIn("session-2", { routeId: other, owner: mate });
  await routes.settleSignIn("session-2", []);
  assert.equal(await routes.routeOwner(other), null);
});

test("a proxy the host configured itself is never cleared or replaced by a direct rule", () => {
  assert.equal(
    credentialProxy(null, "http://proxy.example.test:3128"),
    "http://proxy.example.test:3128",
  );
  assert.equal(credentialProxy(null, routeProxyUrl(home)), "");
  assert.equal(credentialProxy(null, ""), "");
  assert.throws(() => routeProxyUrl("rt_../../x"));
});
