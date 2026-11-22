import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { poolDatabase } from "../../src/pool/database-settings.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { ComputerHome } from "../../src/pool/computer-home.ts";
import { HomeMembership } from "../../src/pool/home-membership.ts";
import {
  accountMirrorPath,
  accountMirrorPrefix,
  handleAccountKeyMirror,
} from "../../src/pool/account-key-mirror.ts";
import { readHomeConfigProxies } from "../../src/pool/account-config-mirror.ts";
import {
  RouteAssignments,
  routeProxyUrl,
  unassignedRoute,
  type RouteResolution,
  type RouteStorage,
} from "../../src/pool/route-assignments.ts";
import { routeDownAnswer, routePeerAddress } from "../../src/pool/route-refusal.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { managedMigrationUrl } from "./managed-postgres.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname)) {
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");
}
const image = process.env.POOL_TEST_IMAGE ?? "basalt-1409-pool:test";
const standin = fileURLToPath(
  new URL("../../containers/pool/route_standin_test.py", import.meta.url),
);
const managementKey = "fixture-management-key";
const signingKey = "6b".repeat(32);
const scope = { organization: "example-organization", pool: "example-pool" };
const owner = "org/example-organization/user/example-user";
const route = "rt_" + "r".repeat(26);
const refused = "rt_refused" + "f".repeat(19);
const down = "rt_down" + "d".repeat(22);
const reference = (n: number) => `12345678-abcd-4000-8000-${String(n).padStart(12, "0")}`;
const [routed, unrouted, refusedRef, downRef, oauthRouted, oauthDirect, teammate, gated, early] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
].map(reference);

function docker(args: string[], timeout = 60_000): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function until<T>(probe: () => Promise<T | undefined>, timeout = 90_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The route rig did not reach the expected state within the test budget");
}
function memory(): RouteStorage {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => structuredClone(map.get(key)),
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => map.delete(key),
    list: async ({ prefix }) => new Map([...map].filter(([key]) => key.startsWith(prefix))),
  };
}
interface Records {
  tunnels: string[];
  connects: { route: string; host: string; port: number; refused: boolean }[];
  dns: string[];
  provider: { from: string; path: string; key: string }[];
}

test(
  "routed credentials leave only through their route, refused routes send nothing, and the global covers the node's own calls",
  { timeout: 600_000 },
  async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    const network = `basalt-route-test-${process.pid}`;
    const containers: string[] = [];
    try {
      const migrationUrl = await managedMigrationUrl(admin, adminUrl!);
      await admin.query("CREATE ROLE pool_route_test LOGIN PASSWORD 'fixture-only'");
      const provision = spawnSync(process.execPath, ["scripts/ensure-pool-database.ts"], {
        env: {
          ...process.env,
          POOL_DATABASE_ADMIN_URL: migrationUrl,
          POOL_DATABASE_RUNTIME_ROLE: "pool_route_test",
        },
        encoding: "utf8",
      });
      assert.equal(provision.status, 0, provision.stderr);
      const databaseUrl = new URL(adminUrl!);
      databaseUrl.hostname = "host.docker.internal";
      databaseUrl.username = "pool_route_test";
      databaseUrl.password = "fixture-only";
      databaseUrl.pathname = `/${poolDatabase.name}`;
      databaseUrl.searchParams.set("options", `-c role=${poolDatabase.owner}`);

      docker(["network", "create", network]);
      // The stand-in plays route-peer.internal (I2), the gateway (I1), the provider and the
      // pool's only DNS server: every name the pool looks up itself is a direct call, recorded.
      const relay = docker([
        "run",
        "--detach",
        "--name",
        `${network}-standin`,
        "--network",
        network,
        "--network-alias",
        "route-peer.internal",
        "--network-alias",
        "models.example.test",
        "--user",
        "0:0",
        "--entrypoint",
        "python3",
        "--volume",
        `${standin}:/standin/route_standin_test.py:ro`,
        "--publish",
        "127.0.0.1::9090",
        image,
        "-I",
        "/standin/route_standin_test.py",
        "models.example.test",
        "9000",
      ]);
      containers.push(relay);
      await until(async () =>
        docker(["logs", relay]).includes("ROUTE_STANDIN_READY") ? true : undefined,
      );
      const address = (id: string) =>
        docker([
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          id,
        ]);
      const relayAddress = address(relay);
      const control = `http://${docker(["port", relay, "9090"])}`;
      const records = async (): Promise<Records> =>
        (await fetch(control)).json() as Promise<Records>;
      const reset = async () => void (await fetch(control, { method: "POST" }));

      const pool = docker([
        "run",
        "--detach",
        "--name",
        `${network}-pool`,
        "--network",
        network,
        "--dns",
        relayAddress,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--memory",
        "512m",
        "--publish",
        "127.0.0.1::8317",
        "--publish",
        "127.0.0.1::8318",
        "--publish",
        "127.0.0.1::8327",
        "--env",
        `POOL_DATABASE_URL=${databaseUrl}`,
        "--env",
        `POOL_MANAGEMENT_KEY=${managementKey}`,
        "--env",
        "POOL_MANAGEMENT_ALLOW_REMOTE=true",
        image,
      ]);
      containers.push(pool);
      const poolAddress = address(pool);
      const origin = (port: number) => `http://${docker(["port", pool, String(port)])}`;
      const ready = async () => {
        const readiness = origin(8318);
        await until(async () =>
          (
            await fetch(`${readiness}/ready`, {
              headers: { Authorization: `Bearer ${managementKey}` },
            })
          ).ok
            ? true
            : undefined,
        );
      };
      await ready();
      // The node's own calls at boot, before anything is routed: each lookup is a direct call.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const bootDirect = [...new Set((await records()).dns)].sort();

      const node = origin(8317);
      // A restart can move the published ports, so each call looks them up.
      const home = new HomeClient((path, init) =>
        fetch(`${origin(8327)}${path}`, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            "X-Management-Key": managementKey,
          },
        }),
      );
      const table: Record<string, RouteResolution> = {
        [routed]: { routeId: route, owner },
        [refusedRef]: { routeId: refused, owner },
        [downRef]: { routeId: down, owner },
        [oauthRouted]: { routeId: route, owner },
        [unrouted]: { routeId: null, owner },
        [oauthDirect]: { routeId: null, owner },
      };
      let revision = 1;
      // Rules are not served at first (the tools service answers 404), as on main today.
      let served = false;
      const unresolvable = new Set<string>();
      const routes = new RouteAssignments(
        memory(),
        {
          resolve: async (_scope, references) => {
            if (references.some((item) => unresolvable.has(item)))
              throw new Error("synthetic resolve outage");
            return {
              served,
              revision: served ? revision : 0,
              resolutions: new Map(
                references.map((item) => [
                  item,
                  (served && table[item]) || { routeId: null, owner: null },
                ]),
              ),
            };
          },
        },
        home,
      );
      // The worker's membership step: routes first, then Home's channel membership.
      const members: string[] = [];
      const membership = async (next: string[]) => {
        await routes.prepare(scope, next, AbortSignal.timeout(30_000));
        await new HomeMembership(home).reconcile(scope.pool, next);
        members.splice(0, members.length, ...next);
      };
      // `hint` is what the host adds once it serves rules: hasRules, and its pool-free route.
      const mirror = async (
        item: string,
        action: string,
        credential: Record<string, unknown>,
        hint: Record<string, unknown> = {},
      ) => {
        const at = Date.now();
        const envelope = await signEnvelope(signingKey, accountMirrorPrefix, {
          at,
          expiresAt: at + 20_000,
          reference: item,
          action,
          credential,
          ...hint,
        });
        const response = await handleAccountKeyMirror(
          new Request(`https://pool.example${accountMirrorPath}`, {
            method: "POST",
            body: JSON.stringify({ envelope }),
          }),
          { home, signingKey, routes },
        );
        assert.equal(response.status, 200, await response.clone().text());
      };
      const apiKey = (alias: string, token: string) => ({
        type: "config",
        family: "openai-compatibility",
        token,
        group: {
          name: alias,
          "base-url": "http://models.example.test:9000/v1",
          models: [
            { name: "fixture-model", alias, thinking: { levels: ["low", "medium", "high"] } },
          ],
        },
      });
      const expired = {
        type: "claude",
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        expired: "2020-01-01T00:00:00Z",
      };
      const chatWith = (key: string, model: string) =>
        fetch(`${origin(8317)}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: "user", content: "fixture" }],
          }),
          signal: AbortSignal.timeout(180_000),
        });
      const listed = async (key: string, ids: string[]) =>
        until(async () => {
          const models = (await (
            await fetch(`${origin(8317)}/v1/models`, {
              headers: { Authorization: `Bearer ${key}` },
            })
          ).json()) as { data?: { id: string }[] };
          return ids.every((id) => models.data?.some((model) => model.id === id))
            ? true
            : undefined;
        });

      // No rules anywhere: a new credential's first token refresh and first model call go exactly
      // as on main. Nothing waits, nothing names a route, no tunnel opens.
      await reset();
      await mirror(unrouted, "upsert", apiKey("direct-model", "direct-model-key"));
      await mirror(early, "upsert", { ...expired, type: "codex" });
      await membership([unrouted, early]);
      const { key: poolKey } = await new ComputerHome(home).mint(
        "example-user",
        scope.pool,
        "route-rig",
      );
      await listed(poolKey, ["direct-model"]);
      const plain = await chatWith(poolKey, "direct-model");
      assert.equal(plain.status, 200);
      await plain.text();
      const noRules = await until(async () => {
        const now = await records();
        return now.dns.includes("auth.openai.com") ? now : undefined;
      }, 120_000);
      assert.deepEqual(noRules.tunnels, []);
      assert.deepEqual(noRules.connects, []);
      assert.deepEqual(
        noRules.provider.map((call) => call.from),
        [poolAddress],
      );
      assert.equal(
        (await readHomeConfigProxies(home, AbortSignal.timeout(10_000))).get(unrouted)?.proxy,
        "",
      );
      await mirror(early, "remove", {});
      served = true;

      for (const [item, alias] of [
        [routed, "routed-model"],
        [refusedRef, "refused-model"],
        [downRef, "down-model"],
      ] as const)
        await mirror(item, "upsert", apiKey(alias, `${alias}-key`), { hasRules: true });
      // Members are routed inside the membership step, before Home may serve them.
      await membership([routed, unrouted, refusedRef, downRef]);
      const written = await readHomeConfigProxies(home, AbortSignal.timeout(10_000));
      assert.equal(written.get(routed)?.proxy, routeProxyUrl(route));
      assert.equal(written.get(unrouted)?.proxy, "");
      await until(async () => {
        const models = (await (
          await fetch(`${node}/v1/models`, { headers: { Authorization: `Bearer ${poolKey}` } })
        ).json()) as { data?: { id: string }[] };
        return ["routed-model", "direct-model", "refused-model", "down-model"].every((id) =>
          models.data?.some((model) => model.id === id),
        )
          ? true
          : undefined;
      });

      const chat = (model: string) =>
        fetch(`${node}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${poolKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            stream: true,
            messages: [{ role: "user", content: "fixture" }],
          }),
          signal: AbortSignal.timeout(180_000),
        });

      await reset();
      // Routed: through the tunnel, unresolved, and the stream keeps its one-second cadence.
      const started = Date.now();
      const stream = await chat("routed-model");
      assert.equal(stream.status, 200);
      const arrivals: number[] = [];
      let text = "";
      for await (const chunk of stream.body!) {
        text += new TextDecoder().decode(chunk);
        while (text.includes(`d${arrivals.length}`)) arrivals.push(Date.now() - started);
      }
      assert.equal(arrivals.length, 5, text);
      for (let index = 1; index < arrivals.length; index++)
        assert.ok(
          arrivals[index]! - arrivals[index - 1]! >= 700,
          `stream timing ${arrivals.join(",")}`,
        );
      let seen = await records();
      assert.deepEqual(
        seen.provider.map((call) => [call.from, call.key]),
        [[relayAddress, "Bearer routed-model-key"]],
      );
      assert.deepEqual(seen.connects, [
        { route, host: "models.example.test", port: 9000, refused: false },
      ]);
      assert.ok(
        !seen.dns.includes("models.example.test"),
        "a routed call looked its provider up itself",
      );

      // Unrouted: unchanged, straight from the pool.
      await reset();
      assert.equal((await chat("direct-model")).status, 200);
      seen = await records();
      assert.deepEqual(
        seen.provider.map((call) => [call.from, call.key]),
        [[poolAddress, "Bearer direct-model-key"]],
      );
      assert.deepEqual(seen.tunnels, []);

      // Refused tunnel (I2 1008) and a gateway with its route down (I1 0x02): nothing reaches the provider.
      const refusals: Record<string, string> = {};
      for (const model of ["refused-model", "down-model"]) {
        await reset();
        const request = new Request(`${node}/v1/chat/completions`, { method: "POST" });
        const raw = await chat(model);
        assert.ok(!raw.ok, `${model} answered ${raw.status}`);
        const body = await raw.text();
        const answer = await routeDownAnswer(request, new Response(body, { status: raw.status }));
        const shown = await answer.text();
        refusals[model] = body.includes(routePeerAddress) ? "marker" : "no_marker";
        assert.ok(
          !shown.includes(routePeerAddress) && !shown.includes("models.example.test"),
          shown,
        );
        if (body.includes(routePeerAddress))
          assert.equal(answer.headers.get("X-Signalbox-Route-Refused"), "route_down");
        seen = await records();
        assert.deepEqual(seen.provider, [], `${model} reached the provider`);
        assert.ok(
          !seen.dns.includes("models.example.test"),
          `${model} fell back to a direct lookup`,
        );
      }
      assert.ok(Object.keys(refusals).length === 2);

      // Home refreshes an OAuth credential as soon as it holds it. The routed one's refresh reaches
      // the gateway as a CONNECT and is never looked up; the direct one's is a lookup (the control).
      await reset();
      await mirror(oauthRouted, "upsert", expired, { hasRules: true, route: table[oauthRouted] });
      const refreshHosts = await until(async () => {
        const hosts = (await records()).connects.filter(
          (item) => item.route === route && item.host !== "models.example.test",
        );
        return hosts.length
          ? [...new Set(hosts.map((item) => `${item.host}:${item.port}`))]
          : undefined;
      }, 120_000).catch(async (error: unknown) => {
        console.log("ROUTE_REFRESH_RECORDS", JSON.stringify(await records()));
        throw error;
      });
      assert.deepEqual((await records()).dns, [], "the routed refresh looked its host up directly");
      // The control is another provider, so any later lookup of the routed one's host is a leak.
      await mirror(oauthDirect, "upsert", { ...expired, type: "codex" }, { hasRules: false });
      const directRefresh = await until(async () => {
        const dns = (await records()).dns;
        return dns.length ? [...new Set(dns)] : undefined;
      }, 120_000);
      const routedHosts = new Set(refreshHosts.map((host) => host.split(":")[0]!));
      const noRoutedLookups = async (where: string) => {
        const leaked = (await records()).dns.filter((name) => routedHosts.has(name));
        assert.deepEqual(
          leaked,
          [],
          `the routed credential's host was looked up directly ${where}`,
        );
      };
      await noRoutedLookups("beside the direct control");
      await membership([routed, unrouted, refusedRef, downRef, oauthRouted, oauthDirect]);

      // Everything through one route: drop the others, and the global follows.
      const configRemoval = { type: "config", family: "openai-compatibility" };
      for (const item of [unrouted, refusedRef, downRef])
        await mirror(item, "remove", configRemoval);
      await mirror(oauthDirect, "remove", {});
      await membership([routed, oauthRouted]);
      revision++;
      await routes.refresh(AbortSignal.timeout(30_000));
      const globalProxy = async () => {
        const requests = (await home.data("/config")).requests as
          | Record<string, unknown>
          | undefined;
        return requests?.["proxy-url"];
      };
      assert.equal(await globalProxy(), routeProxyUrl(route));
      // Home reloads on the global change; the routed credential keeps its route through it.
      await reset();
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      await noRoutedLookups("after the global was set");
      // The node picks the Home-set global up across a restart; its own calls are then routed.
      await reset();
      docker(["restart", "--time", "20", pool], 120_000);
      await ready();
      await new Promise((resolve) => setTimeout(resolve, 20_000));
      const afterGlobal = await records();
      const routedBackground = [
        ...new Set(
          afterGlobal.connects
            .filter((item) => item.host !== "models.example.test")
            .map((item) => item.host),
        ),
      ].sort();
      const stillDirect = [...new Set(afterGlobal.dns)].sort();
      assert.deepEqual(
        afterGlobal.dns.filter((name) => routedHosts.has(name)),
        [],
        "the routed credential leaked after the restart",
      );
      assert.equal(await globalProxy(), routeProxyUrl(route));

      // A teammate's credential while the global names someone else's route: explicitly direct.
      await mirror(teammate, "upsert", apiKey("teammate-model", "teammate-model-key"), {
        hasRules: false,
      });
      await membership([routed, oauthRouted, teammate]);
      assert.equal(
        (await readHomeConfigProxies(home, AbortSignal.timeout(10_000))).get(teammate)?.proxy,
        "direct",
      );
      await until(async () => {
        const models = (await (
          await fetch(`${origin(8317)}/v1/models`, {
            headers: { Authorization: `Bearer ${poolKey}` },
          })
        ).json()) as { data?: { id: string }[] };
        return models.data?.some((model) => model.id === "teammate-model") ? true : undefined;
      });
      await reset();
      const mate = await fetch(`${origin(8317)}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${poolKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "teammate-model",
          stream: true,
          messages: [{ role: "user", content: "fixture" }],
        }),
      });
      assert.equal(mate.status, 200);
      await mate.text();
      seen = await records();
      assert.deepEqual(
        seen.provider.map((call) => [call.from, call.key]),
        [[poolAddress, "Bearer teammate-model-key"]],
      );
      assert.deepEqual(seen.tunnels, [], "the teammate's call went through someone else's route");

      // A new member whose route can't be resolved never joins the pool, so it never serves.
      // Not claimed by any pool yet and its owner has rules: it waits on the refusing route, and a
      // failed resolve in its membership step keeps it there while the step itself goes on.
      await mirror(gated, "upsert", apiKey("gated-model", "gated-model-key"), { hasRules: true });
      table[gated] = { routeId: route, owner };
      unresolvable.add(gated);
      await membership([...members, gated]);
      assert.equal(
        (await readHomeConfigProxies(home, AbortSignal.timeout(10_000))).get(gated)?.proxy,
        routeProxyUrl(unassignedRoute),
      );
      await reset();
      const blocked = await fetch(`${origin(8317)}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${poolKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gated-model",
          stream: true,
          messages: [{ role: "user", content: "fixture" }],
        }),
      });
      await blocked.text();
      assert.ok(!blocked.ok, `an unresolved member served (${blocked.status})`);
      assert.deepEqual((await records()).provider, [], "an unresolved member reached the provider");

      console.log(
        "ROUTE_PROOF",
        JSON.stringify({
          streamArrivalsMs: arrivals,
          refusals,
          refreshHosts,
          directRefresh,
          bootDirect,
          routedBackground,
          stillDirect,
        }),
      );
    } finally {
      for (const id of containers.reverse()) spawnSync("docker", ["rm", "--force", id]);
      spawnSync("docker", ["network", "rm", network]);
      await admin.query(`DROP DATABASE IF EXISTS ${poolDatabase.name} WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${poolDatabase.owner}`);
      await admin.query("DROP ROLE IF EXISTS pool_route_test");
      await admin.end();
    }
  },
);
