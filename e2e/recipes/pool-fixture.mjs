import { createServer } from "node:http";
import { once } from "node:events";
import { PoolControl } from "../../src/pool/attribution.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { Computers } from "../../src/pool/computers.ts";

/** The production control API with only its external Home management service simulated. */
export async function startPoolFixture(signingKey) {
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
  const sends = [];
  const users = new Map();
  const accessCalls = [];
  const collections = new Map();
  const removals = new Map();
  const timers = new Set();
  const home = async (path, init) => {
    const url = new URL(path, "http://synthetic-home.test");
    const route = url.pathname.replace("/v8/management", "");
    if (route === "/users") {
      if (init?.method === "POST") {
        const user = JSON.parse(init.body);
        users.set(user.username, { ...user, id: ++sequence });
        return Response.json({ status: "ok" });
      }
      return Response.json({ users: [...users.values()] });
    }
    if (route === "/credentials") {
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
      members.delete(Number(route.split("/").at(-1)));
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
  const control = new PoolControl(storage, { signingKey, home, audience: async () => [] });
  const computers = new Computers({
    storage,
    signingKey,
    home: new ComputerHome(new HomeClient(home)),
  });
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      if (request.url === "/send" && request.method === "POST") {
        sends.push(JSON.parse(body.toString()));
        response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ receipt: `synthetic-${sends.length}` }));
        return;
      }
      const access = request.url === "/pool/v1/access";
      const handler = access
        ? (request) => computers.access(request)
        : (request) => control.handle(request);
      const result = await handler(
        new Request(`http://127.0.0.1${request.url}`, {
          method: request.method,
          headers: request.headers,
          ...(body.length ? { body } : {}),
        }),
      );
      if (access) accessCalls.push(result.status);
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response
        .writeHead(500, { "Content-Type": "application/json" })
        .end('{"error":"fixture-failed"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    sends,
    accessCalls,
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
      let enter, release;
      const started = new Promise((resolve) => {
        enter = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      removals.set(id, { enter, released, release });
      return { started, release };
    },
    completeCollectionAt(id, at, complete) {
      collections.set(id, { at, complete });
    },
    disappear(id) {
      files.delete(id);
      readings.delete(id);
    },
    async stop() {
      for (const removal of removals.values()) removal.release();
      removals.clear();
      for (const timer of timers) {
        clearTimeout(timer.id);
        timer.reject(new Error("Synthetic collection closed"));
      }
      timers.clear();
      collections.clear();
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
