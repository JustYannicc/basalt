import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { HomeAccountAcquisitions } from "../../src/pool/account-acquisition.ts";
import {
  accountAcquisitionPath,
  accountAcquisitionPrefix,
} from "../../src/pool/account-acquisition-contract.ts";
import {
  RouteAssignments,
  routeProxyUrl,
  unassignedRoute,
  type RouteResolution,
  type RouteStorage,
} from "../../src/pool/route-assignments.ts";
import { homeReferences } from "../../src/pool/home-references.ts";
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
const signInRoute = "rt_" + "s".repeat(26);
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
/**
 * A CA made for this run only, and a certificate it signs for the vendor's token host. Only the
 * pool container trusts it, as its system root bundle, so a sign-in can finish against the stand-in.
 */
function throwawayVendorCertificates(): string {
  const directory = mkdtempSync(join(tmpdir(), "basalt-route-vendor-"));
  try {
    return signVendorCertificates(directory);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}
function signVendorCertificates(directory: string): string {
  const ssl = (...args: string[]) => {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  writeFileSync(
    join(directory, "ca.ext"),
    // It can only ever vouch for the one host the stand-in plays.
    "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n" +
      "nameConstraints=critical,permitted;DNS:api.anthropic.com\n",
  );
  writeFileSync(
    join(directory, "vendor.ext"),
    "subjectAltName=DNS:api.anthropic.com\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n",
  );
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca-key.pem");
  ssl("req", "-new", "-key", "ca-key.pem", "-subj", "/CN=route rig throwaway CA", "-out", "ca.csr");
  ssl(
    "x509",
    "-req",
    "-in",
    "ca.csr",
    "-signkey",
    "ca-key.pem",
    "-sha256",
    "-days",
    "1",
    "-extfile",
    "ca.ext",
    "-out",
    "ca.pem",
  );
  ssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "vendor-key.pem");
  ssl(
    "req",
    "-new",
    "-key",
    "vendor-key.pem",
    "-subj",
    "/CN=api.anthropic.com",
    "-out",
    "vendor.csr",
  );
  ssl(
    "x509",
    "-req",
    "-in",
    "vendor.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca-key.pem",
    "-sha256",
    "-set_serial",
    "2",
    "-days",
    "1",
    "-extfile",
    "vendor.ext",
    "-out",
    "vendor.pem",
  );
  // Nothing can sign with this CA again once the run has its certificate.
  rmSync(join(directory, "ca-key.pem"));
  // The pool's own user reads the CA through a bind mount; only the stand-in (root) reads the key.
  chmodSync(directory, 0o755);
  for (const file of ["ca.pem", "vendor.pem"]) chmodSync(join(directory, file), 0o644);
  chmodSync(join(directory, "vendor-key.pem"), 0o600);
  return directory;
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    : [];
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
  vendor: { grant: string | null; presented: string | null; issued: number | null }[];
}

test("routed credentials and sign-ins leave only through their route, refused routes send nothing, and the node's global proxy is never set", async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const network = `basalt-route-test-${process.pid}`;
  const containers: string[] = [];
  let vendorCertificates: string | undefined;
  try {
    vendorCertificates = throwawayVendorCertificates();
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
      "--volume",
      `${vendorCertificates}:/vendor:ro`,
      "--publish",
      "127.0.0.1::9090",
      image,
      "-I",
      "/standin/route_standin_test.py",
      "models.example.test",
      "9000",
      "/vendor",
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
    const records = async (): Promise<Records> => (await fetch(control)).json() as Promise<Records>;
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
      // Test-only: the throwaway CA joins this container's system roots. SSL_CERT_FILE
      // can't carry it, because Home gets only the supervisor's own environment. Every other
      // phase refuses or never resolves before TLS, so this changes nothing but the vendor sign-in.
      "--volume",
      `${join(vendorCertificates, "ca.pem")}:/etc/ssl/certs/ca-certificates.crt:ro`,
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
    const bootDirect = await until(async () => {
      const dns = (await records()).dns;
      return dns.length ? [...new Set(dns)].sort() : undefined;
    });

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
        models: [{ name: "fixture-model", alias, thinking: { levels: ["low", "medium", "high"] } }],
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
        return ids.every((id) => models.data?.some((model) => model.id === id)) ? true : undefined;
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
      assert.ok(!shown.includes(routePeerAddress) && !shown.includes("models.example.test"), shown);
      // The rewrite is proven only if the node's text names the listener; it must.
      assert.ok(body.includes(routePeerAddress), `${model}: the node's refusal changed shape`);
      assert.equal(answer.headers.get("X-Signalbox-Route-Refused"), "route_down");
      seen = await records();
      assert.deepEqual(seen.provider, [], `${model} reached the provider`);
      assert.ok(!seen.dns.includes("models.example.test"), `${model} fell back to a direct lookup`);
    }

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
      assert.deepEqual(leaked, [], `the routed credential's host was looked up directly ${where}`);
    };
    await noRoutedLookups("beside the direct control");
    await membership([routed, unrouted, refusedRef, downRef, oauthRouted, oauthDirect]);

    // Everything through one route: the pool still never writes the node's global proxy.
    const configRemoval = { type: "config", family: "openai-compatibility" };
    for (const item of [unrouted, refusedRef, downRef]) await mirror(item, "remove", configRemoval);
    await mirror(oauthDirect, "remove", {});
    await membership([routed, oauthRouted]);
    revision++;
    await routes.refresh(AbortSignal.timeout(30_000));
    const globalProxy = async () => {
      const requests = (await home.data("/config")).requests as Record<string, unknown> | undefined;
      return requests?.["proxy-url"] ?? "";
    };
    assert.equal(await globalProxy(), "");
    // Across a restart the routed credential still never leaves directly; the node's own
    // calls go direct, the named gap.
    await reset();
    docker(["restart", "--time", "20", pool], 120_000);
    await ready();
    // After the restart a routed model call still leaves only through its route; once it has,
    // any direct lookup of a routed host since the restart would show here.
    const resumed = await chatWith(poolKey, "routed-model");
    assert.equal(resumed.status, 200);
    await resumed.text();
    const afterRestart = await until(async () => {
      const seen = await records();
      return seen.connects.some(
        (item) => item.route === route && item.host === "models.example.test",
      )
        ? seen
        : undefined;
    });
    const backgroundDirect = [...new Set(afterRestart.dns)].sort();
    assert.deepEqual(
      afterRestart.dns.filter((name) => routedHosts.has(name)),
      [],
      "the routed credential leaked after the restart",
    );

    // A teammate in a Home where every credential is routed. Home creates an acquired
    // credential itself, without the mirror: it inherits no one's route. Its refresh is a
    // plain direct lookup and no tunnel opens; a mirrored one gets no proxy either.
    await reset();
    await home.data("/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...expired, type: "codex", uuid: teammate }),
    });
    const acquired = await until(async () => {
      const now = await records();
      return now.dns.includes("auth.openai.com") ? now : undefined;
    }, 120_000);
    assert.deepEqual(
      acquired.tunnels,
      [],
      "an acquired credential inherited another owner's route",
    );
    assert.deepEqual(acquired.connects, []);
    const mateKey = reference(10);
    await mirror(mateKey, "upsert", apiKey("teammate-model", "teammate-model-key"), {
      hasRules: false,
    });
    await membership([routed, oauthRouted, mateKey]);
    assert.equal(
      (await readHomeConfigProxies(home, AbortSignal.timeout(10_000))).get(mateKey)?.proxy,
      "",
    );
    await listed(poolKey, ["teammate-model"]);
    await reset();
    const mate = await chatWith(poolKey, "teammate-model");
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

    // A routed owner's sign-in on Home with the session proxy (carry 0758): the code exchange
    // reaches the route as a CONNECT and is never looked up directly. A refused route ends the
    // sign-in as route_unavailable; an open one ends it connected. The sign-in has its own route
    // id, so the earlier routed credential's refreshes can't stand in for its traffic.
    const capabilities = (await home.data("/capabilities")).capabilities as
      | Record<string, unknown>
      | undefined;
    assert.equal(capabilities?.oauth_session_proxy_v1, true, "this image's Home lacks carry 0758");
    let signIn: Record<string, unknown>;
    {
      const retained = new Map<string, unknown>();
      const proxiesOf = async (references: readonly string[]) => {
        const files = rows((await home.data("/credentials")).files);
        return references.map((id) => {
          const file = files.find((row) => row.id === id);
          const proxy = file?.proxy_url ?? file?.["proxy-url"];
          return typeof proxy === "string" ? proxy : null;
        });
      };
      let savedByHome: (string | null)[] | undefined;
      const acquisitions = new HomeAccountAcquisitions(
        {
          get: async <T>(key: string) => structuredClone(retained.get(key)) as T | undefined,
          put: async (key: string, value: unknown) =>
            void retained.set(key, structuredClone(value)),
          getAlarm: async () => null,
          setAlarm: async () => {},
        },
        home,
        signingKey,
        { begin: async () => "rig-marker", settle: async () => {} },
        undefined,
        () => Date.now(),
        {
          beginSignIn: (session, entry) => routes.beginSignIn(session, entry),
          settleSignIn: async (session, references) => {
            // What Home saved by itself, before the pool re-asserts the route.
            if (references.length) savedByHome = await proxiesOf(references);
            return routes.settleSignIn(session, references);
          },
          // One Home and no slot selection: one image, the one the start proves.
          servingImage: async () => "rig-image",
        },
      );
      // Each sign-in is its own operation: a repeated one answers with the first attempt.
      let operation = 0;
      const acquire = async (action: string, input: Record<string, unknown> = {}) => {
        const at = Date.now();
        const envelope = await signEnvelope(signingKey, accountAcquisitionPrefix, {
          owner: "organization:rig",
          provider: "claude",
          operation: `connect:rig:${operation}`,
          action,
          at,
          expiresAt: at + 20_000,
          ...input,
        });
        const response = await acquisitions.handle(
          new Request(`https://pool.example${accountAcquisitionPath}`, {
            method: "POST",
            body: JSON.stringify({ envelope }),
          }),
        );
        return (await response.json()) as Record<string, unknown>;
      };
      const signInOnce = async () => {
        operation += 1;
        await reset();
        const started = await acquire("start", {
          hasRules: true,
          route: { routeId: signInRoute, owner },
        });
        assert.equal(typeof started.session, "string", JSON.stringify(started));
        const authorization = new URL(String(started.url));
        const redirect = authorization.searchParams.get("redirect_uri")!;
        const state = authorization.searchParams.get("state")!;
        await acquire("submit", {
          session: started.session,
          value: `${redirect}?code=fixture-code&state=${encodeURIComponent(state)}`,
        });
        const finished = await until(async () => {
          const answer = await acquire("status", { session: started.session });
          return answer.state === "failed" || answer.state === "connected" ? answer : undefined;
        }, 90_000);
        const seen = await records();
        const exchange = seen.connects.filter(
          (item) => item.route === signInRoute && item.host !== "models.example.test",
        );
        assert.ok(
          exchange.length > 0,
          `the code exchange never reached the route: ${JSON.stringify({ finished, seen })}`,
        );
        for (const item of exchange)
          assert.ok(!seen.dns.includes(item.host), `${item.host} was looked up directly`);
        return {
          finished,
          seen,
          exchange: [...new Set(exchange.map((item) => `${item.host}:${item.port}`))],
        };
      };

      // The route's gateway refuses the token host: the sign-in fails closed.
      const refusedSignIn = await signInOnce();
      assert.deepEqual(refusedSignIn.finished, { state: "failed", message: "route_unavailable" });

      // The gateway now forwards the token host to the stand-in vendor, which listens only on the
      // stand-in's own loopback: the gateway is the only way to reach it.
      await fetch(`${control}/vendor`, { method: "POST" });
      const success = await signInOnce();
      assert.equal(success.finished.state, "connected", JSON.stringify(success));
      const exchanged = success.seen.vendor.filter((item) => item.grant === "authorization_code");
      assert.equal(exchanged.length, 1, JSON.stringify(success.seen));
      // Every dial of the token host is a CONNECT on a route, never refused now; the sign-in's own
      // ones are on its route.
      const tokenHost = (seen: Records) =>
        seen.connects.filter((item) => item.host === "api.anthropic.com");
      const onRoutes = (seen: Records) => {
        for (const item of tokenHost(seen)) {
          assert.ok([route, signInRoute].includes(item.route), JSON.stringify(item));
          assert.deepEqual([item.port, item.refused], [443, false]);
        }
      };
      onRoutes(success.seen);
      assert.ok(tokenHost(success.seen).some((item) => item.route === signInRoute));
      assert.ok(!success.seen.dns.includes("api.anthropic.com"), "the token host was looked up");
      const saved = homeReferences(String(success.finished.ref));
      assert.ok(saved.length > 0);
      assert.deepEqual(
        savedByHome,
        saved.map(() => routeProxyUrl(signInRoute)),
      );
      assert.deepEqual(
        await proxiesOf(saved),
        saved.map(() => routeProxyUrl(signInRoute)),
      );

      // Home refreshes what it saved with the refresh token the exchange issued, through the route.
      const issued = exchanged[0]!.issued;
      const refreshed = await until(async () => {
        const seen = await records();
        return seen.vendor.some(
          (item) =>
            item.grant === "refresh_token" && item.presented === `fixture-refresh-${issued}`,
        )
          ? seen
          : undefined;
      }, 180_000).catch(async (error: unknown) => {
        console.log("ROUTE_SIGN_IN_REFRESH_RECORDS", JSON.stringify(await records()));
        throw error;
      });
      onRoutes(refreshed);
      assert.ok(!refreshed.dns.includes("api.anthropic.com"), "the refresh looked its host up");
      signIn = {
        refused: { exchange: refusedSignIn.exchange, finished: refusedSignIn.finished },
        connected: {
          exchange: success.exchange,
          vendor: success.seen.vendor.map((item) => item.grant),
          savedProxyIsRoute: true,
          signInConnects: tokenHost(refreshed).filter((item) => item.route === signInRoute).length,
        },
      };
    }

    console.log(
      "ROUTE_PROOF",
      JSON.stringify({
        streamArrivalsMs: arrivals,
        refusals,
        refreshHosts,
        directRefresh,
        bootDirect,
        backgroundDirect,
        signIn,
      }),
    );
  } finally {
    for (const id of containers.reverse()) spawnSync("docker", ["rm", "--force", id]);
    spawnSync("docker", ["network", "rm", network]);
    if (vendorCertificates) rmSync(vendorCertificates, { recursive: true, force: true });
    await admin.query(`DROP DATABASE IF EXISTS ${poolDatabase.name} WITH (FORCE)`);
    await admin.query(`DROP ROLE IF EXISTS ${poolDatabase.owner}`);
    await admin.query("DROP ROLE IF EXISTS pool_route_test");
    await admin.end();
  }
});
