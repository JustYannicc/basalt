import { unavailable } from "../../src/pool/json.ts";
import { handleRemovalIntent, removalIntentPath } from "../../src/pool/removal-intent.ts";
import { resetProvider } from "./reset-provider.mjs";
import { createServer } from "node:http";
import { once } from "node:events";
import { PoolControl } from "../../src/pool/attribution.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { NativeMemberships } from "../../src/pool/membership.ts";
import { readNativeMembership } from "../../src/pool/membership-read.ts";
import { HomeMembership } from "../../src/pool/home-membership.ts";
import { Computers } from "../../src/pool/computers.ts";
import { openEnvelope } from "../../src/pool/token.ts";

/** The production control API with only its external Home management service simulated. */
export async function startPoolFixture(signingKey, { catalog = [] } = {}) {
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const resets = resetProvider(now);
  const values = new Map();
  const storage = {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async put(key, value) {
      values.set(key, structuredClone(value));
    },
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
  };
  const files = new Map(),
    readings = new Map(),
    groups = new Map(),
    members = new Map();
  let sequence = 0;
  let acquisition;
  const connections = new Map();
  const sends = [];
  const users = new Map();
  const accessCalls = [];
  const collections = new Map();
  const removals = new Map();
  const hold = (key) => {
    let enter, release;
    const started = new Promise((resolve) => {
      enter = resolve;
    });
    const released = new Promise((resolve) => {
      release = resolve;
    });
    removals.set(key, { enter, released, release });
    return { started, release };
  };
  const timers = new Set();
  let stopped = false;
  const home = async (path, init) => {
    const url = new URL(path, "http://synthetic-home.test");
    const route = url.pathname.replace("/v8/management", "");
    const resetReply = await resets.home(route, init, url);
    if (resetReply !== undefined) return resetReply;
    if (route === "/oauth/auth-url" && acquisition) {
      const state = `synthetic-state-${++sequence}`;
      connections.set(state, acquisition);
      return Response.json({
        state,
        url: "https://synthetic-provider.invalid/device",
        flow: "device",
        user_code: "SYNTHETIC",
      });
    }
    if (route === "/oauth/status") {
      const pending = connections.get(url.searchParams.get("state"));
      if (!pending) return Response.json({ status: "error" });
      fixture.seedReset(pending.pool, pending.id, pending.provider, pending.resetCount);
      return Response.json({ status: "ok", auth_id: pending.id });
    }
    if (route === "/users") {
      if (init?.method === "POST") {
        const user = JSON.parse(init.body);
        users.set(user.username, { ...user, id: ++sequence });
        return Response.json({ status: "ok" });
      }
      return Response.json({ users: [...users.values()] });
    }
    if (route === "/credentials/fields" && init?.method === "PATCH") {
      const body = JSON.parse(init.body);
      const file = files.get(body.id);
      if (!file) return Response.json({}, { status: 404 });
      files.set(body.id, { ...file, websockets: body.websockets === true });
      return Response.json({ status: "ok" });
    }
    if (route === "/credentials") {
      if (init?.method === "POST" && acquisition) {
        fixture.seedReset(
          acquisition.pool,
          acquisition.id,
          acquisition.provider,
          acquisition.resetCount,
        );
        return Response.json({ name: `${acquisition.id}.json` });
      }
      if (init?.method === "DELETE") {
        const removal = removals.get(url.searchParams.get("id"));
        if (removal) {
          removal.enter();
          await removal.released;
          removals.delete(url.searchParams.get("id"));
        }
        files.delete(url.searchParams.get("id"));
        return Response.json({ status: "ok" });
      }
      return Response.json({ files: [...files.values()] });
    }
    if (route === "/channel-groups" && init?.method === "POST") {
      const group = { id: ++sequence, channel_name: JSON.parse(init.body).channel_name };
      groups.set(group.channel_name.replace("signalbox-pool-", ""), group);
      return Response.json({ channel_group: group });
    }
    if (route === "/channel-group-details" && init?.method === "POST") {
      const member = { id: ++sequence, ...JSON.parse(init.body) };
      members.set(member.id, member);
      return Response.json({ channel_group_detail: member });
    }
    if (route === "/channel-groups") return Response.json({ channel_groups: [...groups.values()] });
    if (route === "/channel-group-details") {
      const group = Number(url.searchParams.get("channel_group_id"));
      return Response.json({
        channel_group_details: [...members.values()].filter(
          (row) => !group || row.channel_group_id === group,
        ),
      });
    }
    if (route.startsWith("/channel-group-details/") && init?.method === "DELETE") {
      const id = Number(route.split("/").at(-1));
      const key = `membership:${members.get(id)?.auth_id}`;
      const removal = removals.get(key);
      if (removal) {
        removal.enter();
        await removal.released;
        removals.delete(key);
      }
      members.delete(id);
      return Response.json({ status: "ok" });
    }
    if (route.startsWith("/quota/credentials/")) {
      const id = decodeURIComponent(route.split("/").at(-1));
      const collection = collections.get(id);
      if (collection) {
        collections.delete(id);
        await new Promise((resolve, reject) => {
          const timer = { reject };
          timer.id = setTimeout(
            () => {
              timers.delete(timer);
              resolve();
            },
            Math.max(0, collection.at - Date.now()),
          );
          timers.add(timer);
        });
        collection.complete();
      }
      return readings.has(id)
        ? Response.json(readings.get(id))
        : Response.json({}, { status: 404 });
    }
    if (route === "/quota/credentials")
      return Response.json({ items: [...readings.values()].map((row) => row.credential) });
    throw new Error(`Unsupported synthetic Home operation: ${route}`);
  };
  const dependencies = { signingKey, home, audience: async () => [], now: () => new Date(now()) };
  let control = new PoolControl(storage, dependencies);
  const computers = new Computers({
    storage,
    signingKey,
    home: new ComputerHome(new HomeClient(home)),
  });
  let productOrigin;
  const homeMembership = new HomeMembership(new HomeClient(home));
  const memberships = new NativeMemberships({
    storage,
    signingKey,
    read: (pool, organization) => {
      if (!productOrigin) throw new Error("The fixture has no product origin");
      return readNativeMembership(
        { fetch: (input, init) => fetch(new URL(new URL(input).pathname, productOrigin), init) },
        signingKey,
        pool,
        organization,
      );
    },
    actual: (pool) => homeMembership.actual(pool),
    reconcile: (pool, accounts) => homeMembership.reconcile(pool, accounts),
    install: async () => {},
    abort: () => {},
    invalidateView: (pool) => control.invalidateViews(pool),
    schedule: async (at) => {
      if (stopped) return;
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          void memberships.tick();
        },
        Math.max(0, at - now()),
      );
      timers.add(timer);
    },
  });
  const traces = [];
  // Signed usage reads the model-history worker would answer. A journey that sets `respond`
  // supplies their synthetic data; every other journey keeps the production control's answers.
  const usage = {
    respond: undefined,
    capacity: undefined,
    history: undefined,
    calls: [],
    requests: [],
    log: [],
  };
  const usageRoutes = new Set([
    "/pool/v1/usage/summary",
    "/pool/v1/usage/series",
    "/pool/v1/usage/overview",
    "/pool/v1/usage/personal-overview",
    "/pool/v1/usage/last-success",
  ]);
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      // Method and path only, for the journey's request inventory; never bodies or credentials.
      const route = `${request.method} ${new URL(request.url ?? "/", "http://127.0.0.1").pathname}`;
      usage.requests.push(route);
      usage.log.push({ at: Date.now(), route });
      const address = new URL(request.url ?? "/", "http://127.0.0.1");
      if (
        usage.capacity &&
        request.method === "GET" &&
        address.pathname === "/pool/v1/usage/capacity"
      ) {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(await usage.capacity(address)));
        return;
      }
      if (
        usage.history &&
        request.method === "GET" &&
        address.pathname === "/pool/v1/usage/history"
      ) {
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify(await usage.history(address)));
        return;
      }
      if (usage.respond && request.method === "POST" && usageRoutes.has(request.url)) {
        let envelope = "";
        try {
          envelope = JSON.parse(body.toString("utf8")).envelope ?? "";
        } catch {}
        const payload = await openEnvelope(signingKey, "sbs1", envelope);
        usage.calls.push({ route: request.url, payload: payload ?? null });
        const reply = payload === undefined ? undefined : await usage.respond(request.url, payload);
        if (reply === undefined) response.writeHead(payload === undefined ? 401 : 404).end();
        else
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify(reply));
        return;
      }
      if (request.url === "/send" && request.method === "POST") {
        sends.push(JSON.parse(body.toString()));
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ receipt: `synthetic-${sends.length}` }));
        return;
      }
      if (request.method === "GET" && request.url === "/catalog/index.json") {
        response.writeHead(200, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            version: 1,
            apps: catalog.map((source) => ({
              id: source.package,
              package: source.package,
              name: source.package === "provider-openai" ? "OpenAI" : "Anthropic",
              description: "Synthetic provider app source",
              auth: [],
              icons: [],
              source: `apps/${source.package}.json`,
            })),
          }),
        );
        return;
      }
      const source = catalog.find(
        (source) => request.url === `/catalog/apps/${source.package}.json`,
      );
      if (request.method === "GET" && source) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(source));
        return;
      }
      if (request.method === "POST" && request.url === "/pool/v1/membership") {
        await memberships.reserve(
          new Request(new URL(request.url, "http://127.0.0.1"), {
            method: "POST",
            headers: request.headers,
            body,
          }),
        );
        response.writeHead(200, { "Content-Type": "application/json" }).end("null");
        return;
      }
      if (request.url === removalIntentPath) {
        const result = await handleRemovalIntent(
          new Request(new URL(request.url, "http://127.0.0.1"), {
            method: request.method,
            headers: request.headers,
            body,
          }),
          {
            signingKey,
            refresh: (pool) => memberships.refresh(pool),
            selected: async (pool) => {
              const policy = await memberships.authority(pool);
              if (!policy) return unavailable();
              return policy.accounts;
            },
            record: (pool, references, actor, operation, issuedAt) =>
              control.recordRemovalIntent(pool, references, actor, operation, issuedAt),
          },
        );
        response
          .writeHead(result.status, Object.fromEntries(result.headers))
          .end(await result.text());
        return;
      }
      const access = request.url === "/pool/v1/access";
      const handler = access
        ? (request) => computers.access(request)
        : request.url.endsWith("/pool/v1/account-acquisitions")
          ? (request) => control.acquire(request)
          : (request) => control.handle(request);
      const result = await handler(
        new Request(new URL(request.url, "http://127.0.0.1"), {
          method: request.method,
          headers: request.headers,
          ...(body.length ? { body } : {}),
        }),
      );
      if (access) accessCalls.push(result.status);
      const reply = Buffer.from(await result.arrayBuffer());
      // Diagnostics only: what this pool answered for an account's observation or check. The
      // account reference in the path is kept for in-process checks and never written as is.
      const observed = /\/accounts\/([^/?]+)\/(observations|collect)/.exec(request.url ?? "");
      if (observed || request.url?.endsWith("/pool/v1/account-acquisitions"))
        traces.push({
          method: request.method,
          route: observed ? `/accounts/<ref>/${observed[2]}` : "/pool/v1/account-acquisitions",
          ...(observed ? { reference: decodeURIComponent(observed[1]) } : {}),
          status: result.status,
          body: reply.toString("utf8").slice(0, 32_768),
        });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(reply);
    } catch {
      response
        .writeHead(500, { "Content-Type": "application/json" })
        .end('{"error":"fixture-failed"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = new URL("http://127.0.0.1");
  origin.port = String(server.address().port);
  const fixture = {
    usage,
    prepareAcquisition(pool, id, provider = "codex", resetCount = 2) {
      acquisition = { pool, id, provider, resetCount };
    },
    origin: origin.origin,
    async reconcile(pool) {
      await memberships.refresh(pool);
      console.error(
        "RESET_MEMBERSHIP",
        JSON.stringify({
          state: values.get("native-pool-memberships-v1"),
          actual: await homeMembership.actual(pool),
          groups: [...groups.values()],
          members: [...members.values()],
          files: [...files.keys()],
        }),
      );
    },
    product(origin) {
      productOrigin = origin;
    },
    traces,
    sends,
    accessCalls,
    resets,
    advance(ms) {
      clockOffset += ms;
    },
    restart() {
      control = new PoolControl(storage, dependencies);
    },
    /** The provider reads this account's usage again now, as its queued refresh does, credits included. */
    refreshReading(id) {
      const reading = readings.get(id);
      const observed = new Date(now()).toISOString();
      reading.collection = {
        ...reading.collection,
        observed_at: observed,
        last_attempt_at: observed,
        next_probe_at: observed,
      };
      reading.windows = reading.windows.map((window) => ({ ...window, observed_at: observed }));
      if (reading.reset_credits !== null) reading.reset_credits = resets.balances(id);
    },
    seedReset(pool, id, provider = "codex", count = 2) {
      this.seed(pool, id);
      files.set(id, { id, provider, disabled: false });
      resets.seed(id, provider, count);
      readings.get(id).reset_credits = resets.balances(id);
    },
    seed(
      pool,
      id,
      {
        remaining = 0.5,
        fresh = true,
        status = "success",
        error = null,
        attemptedAt = Date.now() - 10,
      } = {},
    ) {
      if (pool !== null) {
        let group = groups.get(pool);
        if (!group) {
          group = { id: ++sequence, channel_name: `signalbox-pool-${pool}` };
          groups.set(pool, group);
        }
        if (
          ![...members.values()].some(
            (row) => row.auth_id === id && row.channel_group_id === group.id,
          )
        ) {
          const member = { id: ++sequence, channel_group_id: group.id, auth_id: id };
          members.set(member.id, member);
        }
      }
      files.set(id, { id, provider: "codex", disabled: false });
      const at = new Date(attemptedAt).toISOString();
      const observed = status === "success" ? new Date(attemptedAt + 1).toISOString() : at;
      readings.set(id, {
        credential: { credential_id: id },
        collection: {
          status,
          freshness: fresh ? "fresh" : "stale",
          observed_at: observed,
          last_attempt_at: at,
          next_probe_at: at,
          error: error ? { code: error } : null,
        },
        windows: [
          {
            id: "short",
            scope: "account",
            scope_id: "codex",
            // Home reports each limit window's unit; without one the pool can't show the window.
            unit: "percent",
            window_seconds: 18000,
            remaining_ratio: remaining,
            observed_at: observed,
            reset_at: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
        reset_credits: null,
      });
    },
    holdRemoval(id) {
      return hold(id);
    },
    holdUnlink(id) {
      return hold(`membership:${id}`);
    },
    completeCollectionAt(id, at, complete) {
      collections.set(id, { at, complete });
    },
    hasCredential(id) {
      return files.has(id);
    },
    disappear(id) {
      files.delete(id);
      readings.delete(id);
    },
    async stop() {
      stopped = true;
      resets.stop();
      for (const removal of removals.values()) removal.release();
      removals.clear();
      for (const timer of timers) {
        clearTimeout(timer.id ?? timer);
        timer.reject?.(new Error("Synthetic collection closed"));
      }
      timers.clear();
      collections.clear();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  return fixture;
}
