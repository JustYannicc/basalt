import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  pluginProviders,
  routeProxyUrl,
  routedPluginProviders,
  servedPollMs,
  unassignedRoute,
  unservedPauseMs,
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
    failStatus: false,
    failPost: false,
    postGate: undefined as Promise<void> | undefined,
    posting: () => {},
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
    if (route === "/credentials" && method === "POST" && state.postGate) {
      state.posting();
      await state.postGate;
    }
    if (route === "/credentials" && method === "POST" && state.failPost)
      return new Response(null, { status: 500 });
    if (route === "/credentials" && method === "POST") {
      state.files = state.files.filter((file) => file.id !== body.uuid);
      state.files.push({
        id: body.uuid,
        type: body.type,
        proxy_url: body.proxy_url ?? "",
        ...(body.disabled === true ? { disabled: true } : {}),
      });
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
    if (route === "/credentials/status" && method === "PATCH" && state.failStatus)
      return new Response(null, { status: 500 });
    if (route === "/credentials/status" && method === "PATCH") {
      const file = state.files.find((item) => item.id === body.name);
      if (!file) return Response.json({ error: "not_found" }, { status: 404 });
      state.writes.push(`status:${body.name}:${body.disabled}`);
      file.disabled = body.disabled;
      return Response.json({ status: "ok", disabled: body.disabled });
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
  // Change 37 reversed the hasRules:true part on purpose: that hint is proof of rules, so it is
  // held (next test). Without a hint, or with hasRules:false, everything stays as on main.
  for (const hint of [{}, { hasRules: false }]) {
    assert.equal((await mirror(client, routes, mine, apiKey, hint)).status, 200);
    assert.equal(keyProxy(mine), "");
  }
  assert.equal((await mirror(client, routes, oauth, claude)).status, 200);
  await routes.prepare(scope, [mine, oauth], signal());
  await routes.tick(signal());
  assert.equal(keyProxy(mine), "");
  assert.equal(state.files[0]!.proxy_url, "");
});

test("a hasRules:true credential with no 200 yet is held, not written direct", async () => {
  const { client, keyProxy, state } = fakeHome();
  const rules = scripted({
    [mine]: { routeId: home, owner },
    [oauth]: { routeId: null, owner: null },
  });
  const clock = { at: now };
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => clock.at);
  for (const unserved of ["unreachable", "404"]) {
    rules.fail(unserved === "unreachable");
    rules.serve(unserved !== "404");
    assert.equal((await mirror(client, routes, mine, apiKey, { hasRules: true })).status, 200);
    assert.equal(keyProxy(mine), routeProxyUrl(unassignedRoute));
  }
  assert.equal((await mirror(client, routes, oauth, claude, { hasRules: true })).status, 200);
  // Home refreshes what it holds at once: the first thing it holds already refuses.
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(unassignedRoute));
  // A membership step doesn't turn the hold into direct while rules are not served.
  await routes.prepare(scope, [mine, oauth], signal());
  assert.equal(keyProxy(mine), routeProxyUrl(unassignedRoute));
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(unassignedRoute));
  // The first 200 decides each: its route, or direct.
  rules.fail(false);
  rules.serve(true);
  clock.at += 10 * 60_000;
  await routes.tick(signal());
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(state.files[0]!.proxy_url, "");
});

test("rule changes rewrite only the credentials whose route changed, and a failed pass changes nothing", async () => {
  const { client, state, keyProxy } = fakeHome();
  const rules = scripted({ [mine]: { routeId: home, owner } });
  const clock = { at: now };
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => clock.at);
  // Each alarm here is past the served poll bound.
  const tick = () => {
    clock.at += 60_000;
    return routes.tick(signal());
  };
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, teammate, apiKey);
  await routes.prepare(scope, [mine, teammate], signal());
  await routes.refresh(signal());
  state.writes.length = 0;
  await tick();
  assert.deepEqual(state.writes, []);
  rules.set({ [mine]: { routeId: null, owner: null } });
  rules.fail(true);
  await assert.rejects(tick());
  assert.equal(keyProxy(mine), routeProxyUrl(home));
  assert.equal(await routes.routeOwner(home), owner);
  rules.fail(false);
  await tick();
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

test("a 200 that leaves a reference out means rules are served and fails: only an owner with rules is held", async () => {
  const { client, keyProxy } = fakeHome();
  const partial: RouteResolver = {
    resolve: async () => ({ served: true, revision: 3, resolutions: new Map() }),
  };
  const routes = new RouteAssignments(storage(), partial, client, () => now);
  await routes.prepare(scope, [teammate], signal());
  assert.equal((await mirror(client, routes, mine, apiKey, { hasRules: true })).status, 503);
  // Nobody without rules is touched: no hint, or a host that says there are none.
  assert.equal((await mirror(client, routes, oauth, claude)).status, 200);
  assert.equal((await mirror(client, routes, mine, apiKey, { hasRules: false })).status, 200);
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

test("a member whose host said its owner has no rules never waits on the tools service", async () => {
  const { client, keyProxy } = fakeHome();
  const rules = scripted({});
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await routes.prepare(scope, [], signal());
  await mirror(client, routes, mine, apiKey, { hasRules: false });
  rules.fail(true);
  const calls = rules.calls.length;
  await routes.prepare(scope, [mine], signal());
  assert.equal(rules.calls.length, calls);
  assert.equal(keyProxy(mine), "");
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

test("while rules are not served the alarm asks the tools service at most once per pause; a new member asks at once", async () => {
  const { client } = fakeHome();
  const rules = scripted({});
  rules.serve(false);
  const clock = { at: now };
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => clock.at);
  await routes.prepare(scope, [mine], signal());
  const asked = rules.calls.length;
  // An alarm every 5 s for the whole pause: one ask.
  for (let at = 0; at < unservedPauseMs; at += 5_000) {
    clock.at = now + at;
    await routes.tick(signal());
  }
  assert.equal(rules.calls.length, asked + 1);
  clock.at = now + unservedPauseMs;
  await routes.tick(signal());
  assert.equal(rules.calls.length, asked + 2);
  // A membership change is never paced.
  await routes.prepare(scope, [mine, teammate], signal());
  assert.equal(rules.calls.length, asked + 3);
  // Served, the cheap poll runs at most once per servedPollMs.
  rules.serve(true);
  clock.at += unservedPauseMs;
  await routes.tick(signal());
  // The first 200 ends the unserved pause: the next alarm reads the rules at once.
  const first = rules.calls.length;
  clock.at += 5_000;
  await routes.tick(signal());
  assert.ok(rules.calls.length > first);
  const served = rules.calls.length;
  for (let at = 5_000; at < servedPollMs; at += 5_000) {
    clock.at += 5_000;
    await routes.tick(signal());
  }
  assert.equal(rules.calls.length, served);
});

test("a routed owner's plugin-provider credential is kept disabled, never live on its route, and only the pool's own refusal is lifted", async () => {
  const { client, state } = fakeHome();
  const [gemini, typesafe, paused] = [
    "12345678-abcd-4000-8000-0000000000a1",
    "12345678-abcd-4000-8000-0000000000a2",
    "12345678-abcd-4000-8000-0000000000a3",
  ];
  const rules = scripted({
    [gemini]: { routeId: home, owner },
    [typesafe]: { routeId: home, owner },
    [paused]: { routeId: home, owner },
  });
  const clock = { at: now };
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => clock.at);
  const file = (id: string) => state.files.find((row) => row.id === id)!;
  // TypeSafe is proven: the host's route is written on it, and it stays enabled.
  assert.equal(
    (
      await mirror(
        client,
        routes,
        typesafe,
        { type: "typesafe", token: "synthetic" },
        {
          route: { routeId: home, owner },
        },
      )
    ).status,
    200,
  );
  assert.equal(file(typesafe).disabled, undefined);
  assert.equal(file(typesafe).proxy_url, routeProxyUrl(home));
  assert.equal(await routes.refusesUse(typesafe, "typesafe"), false);
  // Routed by a membership step after it was mirrored: disabled before its proxy changes.
  await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "synthetic" });
  await mirror(client, routes, paused, { type: "gemini-cli", access_token: "synthetic" });
  file(paused).disabled = true;
  assert.equal(file(gemini).disabled, undefined);
  state.writes.length = 0;
  await routes.prepare(scope, [gemini, typesafe, paused], signal());
  assert.deepEqual(state.writes.slice(0, 2), [`status:${gemini}:true`, `auth:${gemini}`]);
  assert.equal(file(gemini).disabled, true);
  assert.deepEqual([...(await routes.refusedReferences())], [gemini]);
  // The route ends: the pool lifts what it disabled, never the owner's own pause.
  rules.set({
    [gemini]: { routeId: null, owner: null },
    [typesafe]: { routeId: null, owner: null },
    [paused]: { routeId: null, owner: null },
  });
  clock.at += servedPollMs;
  await routes.tick(signal());
  assert.equal(file(gemini).disabled, false);
  assert.equal(file(paused).disabled, true);
  assert.equal(file(typesafe).disabled, undefined);
  assert.deepEqual([...(await routes.refusedReferences())], []);
});

test("no route rules anywhere: a plugin-provider credential is mirrored and served exactly as on main", async () => {
  const { client, state } = fakeHome();
  const rules = scripted({});
  rules.serve(false);
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  const gemini = "12345678-abcd-4000-8000-0000000000a4";
  for (const hint of [{}, { hasRules: false }])
    assert.equal(
      (await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" }, hint))
        .status,
      200,
    );
  await routes.prepare(scope, [gemini], signal());
  assert.equal(state.files[0]!.disabled, undefined);
  assert.equal(state.files[0]!.proxy_url, "");
  assert.ok(!state.writes.some((write) => write.startsWith("status:")));
  assert.deepEqual([...(await routes.refusedReferences())], []);
});

test("every provider plugin the pool image ships is refused for routed owners until proven", () => {
  const dockerfile = readFileSync(
    new URL("../../containers/pool/Dockerfile", import.meta.url),
    "utf8",
  );
  const shipped = [...dockerfile.matchAll(/\/opt\/pool\/plugins\/([a-z0-9-]+)\.so\b/g)].map(
    (match) => match[1]!,
  );
  // Every copy into the plugin directory names one .so, so no plugin arrives unnamed.
  const instructions = dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .filter((row) => row.includes("/opt/pool/plugins"));
  // Nothing is written into the plugin directory but by a COPY of one named .so.
  for (const line of instructions.filter((row) => /^\s*RUN\b/.test(row)))
    assert.doesNotMatch(
      line,
      /\b(cp|mv|install|ln|curl|wget|tar)\b[^&;|]*\/opt\/pool\/plugins/,
      line,
    );
  const copies = instructions.filter((row) => /^\s*(COPY|ADD)\b/.test(row));
  assert.ok(copies.length >= 3);
  for (const line of copies) assert.match(line, /\/opt\/pool\/plugins\/[a-z0-9-]+\.so(\s|$)/, line);
  // The scheduler veto is a plugin but makes no provider calls.
  const providers = shipped.filter((name) => name !== "basalt-native-policy");
  assert.ok(providers.length > 0);
  // Each is refused for routed owners until a rig case proves it, and then listed as proven.
  for (const name of providers)
    assert.ok(
      pluginProviders.has(name) !== routedPluginProviders.has(name),
      `${name} must be either refused or proven, never both or neither`,
    );
});

test("a re-mirror without a hint keeps a hold, and a refused plugin credential stays disabled", async () => {
  const { client, keyProxy, state } = fakeHome();
  const rules = scripted({});
  rules.fail(true);
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  const gemini = "12345678-abcd-4000-8000-0000000000a5";
  await mirror(client, routes, mine, apiKey, { hasRules: true });
  await mirror(
    client,
    routes,
    gemini,
    { type: "gemini-cli", access_token: "x" },
    { hasRules: true },
  );
  assert.equal(state.files[0]!.disabled, true);
  await mirror(client, routes, mine, apiKey);
  await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
  assert.equal(keyProxy(mine), routeProxyUrl(unassignedRoute));
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(unassignedRoute));
  assert.equal(state.files[0]!.disabled, true);
  assert.equal(await routes.refusesUse(gemini, "gemini-cli"), true);
  assert.equal(await routes.refusesUse(mine, "codex"), false);
});

test("a plugin credential held because its pools disagree stays refused through the owner's pause", async () => {
  const { client, state } = fakeHome();
  const gemini = "12345678-abcd-4000-8000-0000000000a6";
  // Direct in both pools first, then two routes at once: a hold with no route entry or hint.
  const byPool: Record<string, string | null> = { "pool-a": null, "pool-b": null };
  let revision = 1;
  const resolver: RouteResolver = {
    resolve: async (scope, references) => ({
      served: true,
      revision,
      resolutions: new Map(
        references.map((reference) => {
          const routeId = byPool[scope.pool] ?? null;
          return [reference, routeId ? { routeId, owner } : { routeId: null, owner: null }];
        }),
      ),
    }),
  };
  const routes = new RouteAssignments(storage(), resolver, client, () => now);
  await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
  await routes.prepare({ organization: scope.organization, pool: "pool-a" }, [gemini], signal());
  await routes.prepare({ organization: scope.organization, pool: "pool-b" }, [gemini], signal());
  assert.equal(await routes.refusesUse(gemini, "gemini-cli"), false);
  byPool["pool-a"] = home;
  byPool["pool-b"] = other;
  revision++;
  await routes.refresh(signal());
  assert.equal(state.files[0]!.disabled, true);
  assert.equal(await routes.ownRoute(owner, [gemini]), null);
  // The owner pauses: the pool's lift right goes, the hold still refuses.
  await routes.markRefused(gemini, false);
  assert.equal(await routes.refusesUse(gemini, "gemini-cli"), true);
});

test("a hold decided before Home holds a plugin credential makes a later hint-less mirror save it disabled", async () => {
  const { client, state } = fakeHome();
  const gemini = "12345678-abcd-4000-8000-0000000000a9";
  const store = storage();
  const rules = scripted({});
  rules.fail(true);
  const routes = new RouteAssignments(store, rules.resolver, client, () => now);
  // The host said earlier that its owner has rules; Home doesn't hold it yet.
  store.map.set(`route-hint:${gemini}`, true);
  await routes.prepare(scope, [gemini], signal());
  assert.equal(store.map.get(`route-held:${gemini}`), true);
  await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
  assert.equal(state.files[0]!.disabled, true);
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(unassignedRoute));
});

test("the mirror records a plugin credential's refusal even when Home's save fails", async () => {
  const { client, state } = fakeHome();
  const gemini = "12345678-abcd-4000-8000-0000000000b1";
  const routes = new RouteAssignments(storage(), scripted({}).resolver, client, () => now);
  state.failPost = true;
  const answer = await mirror(
    client,
    routes,
    gemini,
    { type: "gemini-cli", access_token: "x" },
    {
      route: { routeId: home, owner },
    },
  );
  assert.notEqual(answer.status, 200);
  assert.equal(await routes.refused(gemini), true);
});

test("a plugin credential its owner's rules made direct can be paused and resumed", async () => {
  const { client, state } = fakeHome();
  const gemini = "12345678-abcd-4000-8000-0000000000a7";
  const routes = new RouteAssignments(storage(), scripted({}).resolver, client, () => now);
  await mirror(
    client,
    routes,
    gemini,
    { type: "gemini-cli", access_token: "x" },
    {
      hasRules: true,
      route: null,
    },
  );
  assert.equal(state.files[0]!.disabled, undefined);
  assert.equal(await routes.refusesUse(gemini, "gemini-cli"), false);
});

test("a hold on a plugin credential already on a route is still disabled, and the refusal is recorded before Home's write", async () => {
  const { client, state } = fakeHome();
  const gemini = "12345678-abcd-4000-8000-0000000000a8";
  const byPool: Record<string, string> = { "pool-a": home };
  const resolver: RouteResolver = {
    resolve: async (scope, references) => ({
      served: true,
      revision: Object.keys(byPool).length,
      resolutions: new Map(
        references.map((reference) => [
          reference,
          byPool[scope.pool]
            ? { routeId: byPool[scope.pool]!, owner }
            : { routeId: null, owner: null },
        ]),
      ),
    }),
  };
  const routes = new RouteAssignments(storage(), resolver, client, () => now);
  await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
  await routes.prepare({ organization: scope.organization, pool: "pool-a" }, [gemini], signal());
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(home));
  // Re-enabled behind the pool's back while it still names the route.
  state.files[0]!.disabled = false;
  await routes.markRefused(gemini, false);
  // A second pool gives another route: a hold, which keeps the route proxy, still disables it.
  byPool["pool-b"] = other;
  state.failStatus = true;
  state.writes.length = 0;
  await assert.rejects(routes.refresh(signal()));
  await assert.rejects(
    routes.prepare({ organization: scope.organization, pool: "pool-b" }, [gemini], signal()),
  );
  // The failed write left the refusal on record, the hold recorded and the proxy untouched.
  assert.equal(await routes.refused(gemini), true);
  assert.equal(await routes.refusesUse(gemini, "gemini-cli"), true);
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(home));
  assert.ok(!state.writes.includes(`auth:${gemini}`));
  state.failStatus = false;
  await routes.refresh(signal());
  assert.equal(state.files[0]!.disabled, true);
  assert.equal(state.files[0]!.proxy_url, routeProxyUrl(home));
});

test("a mirror's decision and save are one step: a pass can't land between them and be overwritten", async () => {
  const { client, state } = fakeHome();
  const gemini = "12345678-abcd-4000-8000-0000000000b2";
  const rules = scripted({});
  const routes = new RouteAssignments(storage(), rules.resolver, client, () => now);
  await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
  await routes.prepare(scope, [gemini], signal());
  // A hint-less re-mirror decides "direct", then its save to Home is slow.
  let release = () => {};
  state.postGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const posting = new Promise<void>((resolve) => {
    state.posting = resolve;
  });
  const remirror = mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
  await posting;
  // Meanwhile the rules route it and a pass runs.
  rules.set({ [gemini]: { routeId: home, owner } });
  const pass = routes.refresh(signal());
  // Every fake here answers in microtasks: one turn of the event loop lets an unqueued pass finish.
  await new Promise((resolve) => setImmediate(resolve));
  state.postGate = undefined;
  release();
  assert.equal((await remirror).status, 200);
  await pass;
  const file = state.files.find((row) => row.id === gemini)!;
  assert.equal(file.disabled, true);
  assert.equal(file.proxy_url, routeProxyUrl(home));
});

test(
  "a membership step waits for a routing pass only briefly, decides when the queue drains, and the pass keeps its record",
  { timeout: 10_000 },
  async () => {
    const { client } = fakeHome();
    const store = storage();
    const rules = scripted({});
    let release = () => {};
    let entered = () => {};
    let block = false;
    const resolver: RouteResolver = {
      resolve: async (scope, references) => {
        if (block) {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return rules.resolver.resolve(scope, references, signal());
      },
    };
    const routes = new RouteAssignments(store, resolver, client, () => now, 20);
    await routes.prepare(scope, [mine, teammate], signal());
    block = true;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pass = routes.refresh(signal());
    // The pass has read its pool records and is waiting on the tools service.
    await inside;
    // The pass is waiting on the tools service. A step that only drops a member decides nothing
    // and doesn't queue; one that adds a member returns after its short wait, undecided.
    block = false;
    await routes.prepare(scope, [mine], signal());
    await routes.prepare(
      { organization: scope.organization, pool: "other-pool" },
      [oauth],
      signal(),
    );
    assert.equal(store.map.get("route-pool:other-pool"), undefined);
    release();
    await pass;
    const record = store.map.get(`route-pool:${scope.pool}`) as { references: string[] };
    assert.deepEqual(record.references, [mine]);
    // Its turn ran once the queue drained, adding the member it decided.
    await routes.serial(async () => {});
    const other = store.map.get("route-pool:other-pool") as { references: string[] };
    assert.deepEqual(other.references, [oauth]);
  },
);

test(
  "a membership step that can't get its turn behind a mirror's save routes the credential once the save is done",
  { timeout: 10_000 },
  async () => {
    const { client, state } = fakeHome();
    const gemini = "12345678-abcd-4000-8000-0000000000b3";
    const rules = scripted({ [gemini]: { routeId: home, owner } });
    const store = storage();
    const routes = new RouteAssignments(store, rules.resolver, client, () => now, 20);
    await mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
    let release = () => {};
    state.postGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posting = new Promise<void>((resolve) => {
      state.posting = resolve;
    });
    const remirror = mirror(client, routes, gemini, { type: "gemini-cli", access_token: "x" });
    await posting;
    // The mirror holds the queue: the step returns after its short wait, undecided.
    state.postGate = undefined;
    await routes.prepare(scope, [gemini], signal());
    assert.equal(store.map.get(`route-pool:${scope.pool}`), undefined);
    release();
    assert.equal((await remirror).status, 200);
    // Its turn runs right after the save and routes it, without waiting for the next repair.
    await routes.serial(async () => {});
    const file = state.files.find((row) => row.id === gemini)!;
    assert.equal(file.disabled, true);
    assert.equal(file.proxy_url, routeProxyUrl(home));
  },
);

test("a mirror whose envelope expired while it waited behind a pass decides and writes nothing", async () => {
  const { client, state } = fakeHome();
  let release = () => {};
  let entered = () => {};
  const resolver: RouteResolver = {
    resolve: async (_scope, references) => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        served: true,
        revision: 1,
        resolutions: new Map(references.map((r) => [r, { routeId: null, owner: null }])),
      };
    },
  };
  const clock = { at: now };
  const routes = new RouteAssignments(storage(), resolver, client, () => clock.at);
  await routes.prepare(scope, [], signal()).catch(() => {});
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pass = routes.refresh(signal());
  await inside;
  const envelope = await signEnvelope(signingKey, accountMirrorPrefix, {
    at: now,
    expiresAt: now + 10_000,
    reference: mine,
    action: "upsert",
    credential: apiKey,
  });
  // Known when the mirror has passed its receipt checks and joined the queue.
  let queued = () => {};
  const joined = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const serial = routes.serial.bind(routes);
  routes.serial = <T>(work: () => Promise<T>) => {
    queued();
    return serial(work);
  };
  const answer = handleAccountKeyMirror(
    new Request(`https://pool.example${accountMirrorPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    { home: client, signingKey, now: () => clock.at, routes },
  );
  await joined;
  clock.at += 10_000;
  release();
  await pass;
  assert.equal((await answer).status, 503);
  assert.deepEqual(state.codex, []);
});

test(
  "a late membership turn behind a newer step for its pool steps aside, so a member who left isn't put back",
  { timeout: 10_000 },
  async () => {
    const { client } = fakeHome();
    const store = storage();
    let release = () => {};
    let entered = () => {};
    let block = false;
    const rules = scripted({});
    const resolver: RouteResolver = {
      resolve: async (scope, references) => {
        if (block) {
          entered();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return rules.resolver.resolve(scope, references, signal());
      },
    };
    const routes = new RouteAssignments(store, resolver, client, () => now, 20);
    await routes.prepare(scope, [mine], signal());
    block = true;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pass = routes.refresh(signal());
    await inside;
    block = false;
    // Teammate joins (late turn queued), then leaves again before that turn runs.
    await routes.prepare(scope, [mine, teammate], signal());
    await routes.prepare(scope, [mine], signal());
    release();
    await pass;
    await routes.serial(async () => {});
    const record = store.map.get(`route-pool:${scope.pool}`) as { references: string[] };
    assert.deepEqual(record.references, [mine]);
  },
);
