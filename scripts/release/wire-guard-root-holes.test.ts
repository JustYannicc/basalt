/**
 * Root writes the wire guard must refuse, from the adversarial read of its root rule. The local
 * server answers the list, create and read shapes Alchemy's container provider sends and expects.
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { Cause, Effect, Exit } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { install, WireRefused, type WireGuardConfig } from "./wire-guard.ts";
import {
  ACCOUNT,
  applicationBody,
  applicationRead,
  credentials,
} from "./test/wire-guard-fixture.ts";
import { NoRootRecorded, readOnlyRun, wireConfigFor, wireHolds } from "./wire-config.ts";

const RECORDED = "11111111-1111-4111-8111-111111111111";
// The root's live id when State's is stale: what Alchemy then finds by name in the list.
const LIVE = "22222222-2222-4222-8222-222222222222";
const NAME = "basalt-production-poolcontainer";
const root = { ...applicationBody(LIVE), name: NAME };
const envelope = (result: unknown) =>
  JSON.stringify({ success: true, errors: [], messages: [], result });

/** Answers the list with the root, a create with the root, a read of RECORDED as Cloudflare's not-found. */
const startServer = async (
  answers: {
    create?: unknown;
    redirectRead?: boolean;
    /** The account's list; by default the root alone. */
    list?: unknown[];
    /** Reads answered by id. */
    reads?: Record<string, unknown>;
  } = {},
) => {
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    const path = request.url ?? "";
    received.push(`${request.method} ${path}`);
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path.endsWith("/containers/applications"))
      return response.end(envelope(answers.list ?? [root]));
    const read = Object.entries(answers.reads ?? {}).find(([id]) =>
      path.endsWith(`/applications/${id}`),
    );
    if (request.method === "GET" && read) return response.end(envelope(read[1]));
    if (request.method === "POST" && path.endsWith("/containers/applications"))
      return response.end(envelope(answers.create ?? root));
    if (request.method === "GET" && path.endsWith(`/applications/${RECORDED}`)) {
      response.statusCode = 404;
      return response.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 1609, message: "Container application not found" }],
          messages: [],
          result: null,
        }),
      );
    }
    if (
      request.method === "GET" &&
      answers.redirectRead &&
      path.endsWith(`/applications/${LIVE}`)
    ) {
      response.statusCode = 302;
      response.setHeader("location", path.replace(LIVE, "decoy"));
      return response.end();
    }
    if (request.method === "GET" && path.endsWith("/applications/decoy"))
      return response.end(envelope({ id: "decoy", health: { instances: { active: 0 } } }));
    response.end(envelope(root));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return {
    base: `http://127.0.0.1:${address.port}`,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
};

const guarded = async <A, E>(
  context: TestContext,
  config: WireGuardConfig,
  run: (base: string) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  options: Parameters<typeof startServer>[0] = {},
) => {
  const server = await startServer(options);
  context.after(server.close);
  const exit = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install(config);
        return yield* Effect.exit(
          run(server.base).pipe(
            Retry.none,
            credentials(server.base),
            Effect.provide(FetchHttpClient.layer),
            Effect.provide(guard.layer),
          ),
        );
      }),
    ),
  );
  return {
    exit,
    received: server.received,
    writes: server.received.filter((line) => !line.startsWith("GET ")),
  };
};

const refusalOf = (exit: Exit.Exit<unknown, unknown>): WireRefused => {
  assert.ok(Exit.isFailure(exit), "expected the request to be refused");
  let error: unknown = Cause.squash(exit.cause);
  for (let depth = 0; depth < 8 && !(error instanceof WireRefused); depth++) {
    const next = error as { cause?: unknown; reason?: unknown; error?: unknown } | undefined;
    error = next?.reason ?? next?.cause ?? next?.error;
  }
  assert.ok(
    error instanceof WireRefused,
    `no wire guard refusal in ${String(Cause.squash(exit.cause))}`,
  );
  return error;
};

const configuration = applicationBody("x").configuration;
/** The two writes Alchemy's provider sends to the application it found (upsertApplication). */
const patchAndRollout = (applicationId: string) =>
  Effect.gen(function* () {
    const patch = yield* Effect.exit(
      Containers.updateContainerApplication({
        accountId: ACCOUNT,
        applicationId,
        maxInstances: 1,
        configuration,
      } as Containers.UpdateContainerApplicationRequest),
    );
    const rollout = yield* Effect.exit(
      Containers.createContainerApplicationRollout({
        accountId: ACCOUNT,
        applicationId,
        description: "Immediate update",
        strategy: "rolling",
        kind: "full_auto",
        stepPercentage: 100,
        targetConfiguration: configuration,
      } as Containers.CreateContainerApplicationRolloutRequest),
    );
    return { patch, rollout };
  });

test("a root held by id but not by name: the application the provider finds by name is never patched", async (t) => {
  // With State's id stale, Alchemy's reconcile reads it (404), lists, finds the root by name and
  // patches and rolls out its live id. By id alone, nothing knew that application was the root.
  const run = await guarded(
    t,
    { rootApplications: [RECORDED], rootApplicationNames: [], rootRequired: true },
    () =>
      Effect.gen(function* () {
        yield* Effect.exit(
          Containers.getContainerApplication({ accountId: ACCOUNT, applicationId: RECORDED }),
        );
        const apps = yield* Containers.listContainerApplications({ accountId: ACCOUNT });
        const found = apps.find((app) => app.name === NAME);
        assert.ok(found);
        return yield* patchAndRollout(found.id);
      }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  refusalOf(run.exit.value.patch);
  refusalOf(run.exit.value.rollout);
  assert.deepEqual(run.writes, []);
});

test("a held application never stands in for the root's name", async (t) => {
  // The policy's held gateway has a name; the root, known by id alone, still has none. Knowing the
  // root takes the root's own pair, so the provider still never patches it by name.
  const run = await guarded(
    t,
    {
      rootApplications: [RECORDED],
      rootApplicationNames: [],
      rootRequired: true,
      heldApplications: [{ id: "held-application", name: "held-name" }],
    },
    () =>
      Effect.gen(function* () {
        yield* Effect.exit(
          Containers.getContainerApplication({ accountId: ACCOUNT, applicationId: RECORDED }),
        );
        const apps = yield* Containers.listContainerApplications({ accountId: ACCOUNT });
        const found = apps.find((app) => app.name === NAME);
        assert.ok(found);
        return yield* patchAndRollout(found.id);
      }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  refusalOf(run.exit.value.patch);
  refusalOf(run.exit.value.rollout);
  assert.deepEqual(run.writes, []);
});

test("a held application is never written, and one held without a name holds every application", async (t) => {
  const root = { rootApplications: [RECORDED], rootApplicationNames: [NAME], rootRequired: true };
  const held = await guarded(
    t,
    { ...root, heldApplications: [{ id: "held-application", name: "held-name" }] },
    () => patchAndRollout("held-application"),
  );
  assert.ok(Exit.isSuccess(held.exit));
  refusalOf(held.exit.value.patch);
  refusalOf(held.exit.value.rollout);
  assert.deepEqual(held.writes, []);
  // Recorded by id alone, it could be found by name under another id: nothing is written.
  const unnamed = await guarded(
    t,
    { ...root, heldApplications: [{ id: "held-application" }] },
    () => patchAndRollout("another-application"),
  );
  assert.ok(Exit.isSuccess(unnamed.exit));
  refusalOf(unnamed.exit.value.patch);
  refusalOf(unnamed.exit.value.rollout);
  assert.deepEqual(unnamed.writes, []);
});

const GATEWAY = "basalt-production-route-gateway";
const GATEWAY_LIVE = "33333333-3333-4333-8333-333333333333";
const gateway = { ...applicationBody(GATEWAY_LIVE), name: GATEWAY };
/** Finds the gateway in the account's list by name, as the provider does, then patches it. */
const findGatewayAndPatch = () =>
  Effect.gen(function* () {
    const apps = yield* Containers.listContainerApplications({ accountId: ACCOUNT });
    const found = apps.find((app) => app.name.toLowerCase() === GATEWAY);
    assert.ok(found);
    return yield* patchAndRollout(found.id);
  });

test("the entry's holds keep a held name out of the root's, and the guard holds both", async (t) => {
  // What deploy.ts builds: the root as its row records it, the policy's held rows beside it.
  const unnamedRoot = wireHolds({ id: RECORDED }, [{ id: "stale-gateway", name: GATEWAY }]);
  assert.deepEqual(unnamedRoot, {
    rootApplications: [RECORDED],
    rootApplicationNames: [],
    heldApplications: [{ id: "stale-gateway", name: GATEWAY }],
  });
  // The root known by id alone still refuses every container write, the held name notwithstanding.
  const blind = await guarded(t, { ...unnamedRoot, rootRequired: true }, () =>
    patchAndRollout("any-application"),
  );
  assert.ok(Exit.isSuccess(blind.exit));
  refusalOf(blind.exit.value.patch);
  assert.deepEqual(blind.writes, []);
  // With the root named, the held gateway is held by the name the account answers.
  const named = wireHolds({ id: RECORDED, name: NAME }, [
    { id: "stale-gateway", name: GATEWAY },
    undefined,
  ]);
  const run = await guarded(t, { ...named, rootRequired: true }, findGatewayAndPatch, {
    list: [root, gateway],
  });
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  refusalOf(run.exit.value.patch);
  refusalOf(run.exit.value.rollout);
  assert.deepEqual(run.writes, []);
});

test("a held name is held on a stage with no root recorded, and in any case", async (t) => {
  for (const held of [
    { id: "stale-gateway", name: GATEWAY },
    { id: "stale-gateway", name: GATEWAY.toUpperCase() },
  ]) {
    const run = await guarded(t, { heldApplications: [held] }, findGatewayAndPatch, {
      list: [{ ...gateway, name: GATEWAY.toUpperCase() }],
    });
    assert.ok(
      Exit.isSuccess(run.exit),
      String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
    );
    refusalOf(run.exit.value.patch);
    assert.deepEqual(run.writes, [], held.name);
  }
  // Cloudflare's ids are not case sensitive: a held id and a request in another case are the same.
  const lettered = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  for (const [held, sent] of [
    [lettered, lettered.toUpperCase()],
    [lettered.toUpperCase(), lettered],
  ]) {
    const byId = await guarded(t, { heldApplications: [{ id: held!, name: GATEWAY }] }, () =>
      patchAndRollout(sent!),
    );
    assert.ok(Exit.isSuccess(byId.exit));
    refusalOf(byId.exit.value.patch);
    assert.deepEqual(byId.writes, [], `${held} / ${sent}`);
  }
});

test("an unattached application is not deleted while its read names a held application", async (t) => {
  const idle = {
    ...applicationRead({ attached: false, active: 0 }).result,
    id: GATEWAY_LIVE,
    name: GATEWAY,
  };
  const remove = () =>
    Effect.exit(
      Containers.deleteContainerApplication({ accountId: ACCOUNT, applicationId: GATEWAY_LIVE }),
    );
  const held = await guarded(
    t,
    {
      rootApplications: [RECORDED],
      rootApplicationNames: [NAME],
      heldApplications: [{ id: "stale-gateway", name: GATEWAY }],
    },
    remove,
    { reads: { [GATEWAY_LIVE]: idle } },
  );
  assert.ok(Exit.isSuccess(held.exit));
  refusalOf(held.exit.value);
  assert.deepEqual(held.writes, []);
  // The read's name in another case than the held one is the same application.
  const shouted = await guarded(
    t,
    {
      rootApplications: [RECORDED],
      rootApplicationNames: [NAME],
      heldApplications: [{ id: "stale-gateway", name: GATEWAY }],
    },
    remove,
    { reads: { [GATEWAY_LIVE]: { ...idle, name: GATEWAY.toUpperCase() } } },
  );
  assert.ok(Exit.isSuccess(shouted.exit));
  refusalOf(shouted.exit.value);
  assert.deepEqual(shouted.writes, []);
  // The same delete of an application nobody holds goes through: the refusal is the name's.
  const other = await guarded(
    t,
    {
      rootApplications: [RECORDED],
      rootApplicationNames: [NAME],
      heldApplications: [{ id: "stale-gateway", name: "another" }],
    },
    remove,
    { reads: { [GATEWAY_LIVE]: idle } },
  );
  assert.ok(Exit.isSuccess(other.exit));
  assert.deepEqual(other.writes, [
    `DELETE /accounts/${ACCOUNT}/containers/applications/${GATEWAY_LIVE}`,
  ]);
});

test("the run's holds come from the policy's rows, and an unnamed root still refuses every write", async (t) => {
  const rows: Record<string, { id: string; name?: string }> = {
    PoolContainer: { id: RECORDED },
    RouteGateway: { id: "stale-gateway", name: GATEWAY },
  };
  const read = (fqn: string) => Effect.succeed(rows[fqn]);
  const holds = await Effect.runPromise(
    wireConfigFor({
      stage: "production",
      policy: { rootFqn: "PoolContainer", held: ["RouteGateway"] },
      recorded: read,
    }),
  );
  assert.deepEqual(holds, {
    rootApplications: [RECORDED],
    rootApplicationNames: [],
    heldApplications: [{ id: "stale-gateway", name: GATEWAY }],
    rootRequired: true,
    unnamedRoot: true,
  });
  const { unnamedRoot: _unnamed, ...config } = holds;
  const run = await guarded(t, config, () => patchAndRollout("any-application"));
  assert.ok(Exit.isSuccess(run.exit));
  refusalOf(run.exit.value.patch);
  assert.deepEqual(run.writes, []);
  // A named root, and the gateway held by the name its row records.
  rows.PoolContainer = { id: RECORDED, name: NAME };
  const named = await Effect.runPromise(
    wireConfigFor({
      stage: "production",
      policy: { rootFqn: "PoolContainer", held: ["RouteGateway"] },
      recorded: read,
    }),
  );
  const { unnamedRoot: _n, ...namedConfig } = named;
  const gatewayRun = await guarded(t, namedConfig, findGatewayAndPatch, { list: [root, gateway] });
  assert.ok(Exit.isSuccess(gatewayRun.exit));
  refusalOf(gatewayRun.exit.value.patch);
  assert.deepEqual(gatewayRun.writes, []);
  // Production under a policy that records no root stops; a preview without one holds nothing.
  const none = await Effect.runPromiseExit(
    wireConfigFor({ stage: "production", policy: { rootFqn: "Absent", held: [] }, recorded: read }),
  );
  assert.ok(Exit.isFailure(none) && Cause.squash(none.cause) instanceof NoRootRecorded);
  assert.deepEqual(
    await Effect.runPromise(
      wireConfigFor({ stage: "test-preview", policy: undefined, recorded: read }),
    ),
    {
      rootApplications: [],
      rootApplicationNames: [],
      heldApplications: [],
      rootRequired: false,
      unnamedRoot: false,
    },
  );
});

test("only a production command that writes nothing runs read-only, a repair without its digest included", () => {
  for (const command of ["plan", "preflight", "snapshot", "serving"])
    assert.equal(readOnlyRun("production", command, undefined), true, command);
  assert.equal(readOnlyRun("production", "repair", undefined), true);
  assert.equal(readOnlyRun("production", "repair", "f".repeat(64)), false);
  assert.equal(readOnlyRun("production", "apply", "f".repeat(64)), false);
  assert.equal(readOnlyRun("test-route-scratch-1", "repair", undefined), false);
});

test("a production run that has not pushed the root refuses every container application write", async (t) => {
  // Production keeps the root from the first request on (deploy.ts): until both the root's id and
  // name are pushed, which a command without a policy and a row without a name never had.
  for (const config of [
    { rootApplications: [], rootApplicationNames: [], rootRequired: true },
    { rootApplications: [RECORDED], rootApplicationNames: [], rootRequired: true },
  ]) {
    const run = await guarded(t, config, () => patchAndRollout(RECORDED));
    assert.ok(Exit.isSuccess(run.exit));
    refusalOf(run.exit.value.patch);
    refusalOf(run.exit.value.rollout);
    assert.deepEqual(run.writes, [], JSON.stringify(config));
  }
});

test("an application create answered with the root's name holds that id", async (t) => {
  // A create's answer that Cloudflare names as the root is the root, as a read's answer is.
  const run = await guarded(t, { rootApplications: [RECORDED], rootApplicationNames: [NAME] }, () =>
    Effect.gen(function* () {
      const created = yield* Containers.createContainerApplication({
        accountId: ACCOUNT,
        name: NAME,
        maxInstances: 1,
        configuration,
      } as Containers.CreateContainerApplicationRequest);
      const { patch } = yield* patchAndRollout(created.id);
      const removal = yield* Effect.exit(
        Containers.deleteContainerApplication({ accountId: ACCOUNT, applicationId: created.id }),
      );
      return { patch, removal };
    }),
  );
  assert.ok(
    Exit.isSuccess(run.exit),
    String(Exit.isFailure(run.exit) && Cause.squash(run.exit.cause)),
  );
  refusalOf(run.exit.value.patch);
  refusalOf(run.exit.value.removal);
  assert.deepEqual(run.writes, [`POST /accounts/${ACCOUNT}/containers/applications`]);
});

test("the unattached check never follows a redirect to another application's read", async (t) => {
  const run = await guarded(
    t,
    { rootApplications: [RECORDED], rootApplicationNames: [NAME] },
    () => Containers.deleteContainerApplication({ accountId: ACCOUNT, applicationId: LIVE }),
    { redirectRead: true },
  );
  assert.equal(refusalOf(run.exit).field, "application read");
  assert.ok(!run.writes.some((line) => line.startsWith("DELETE")), run.received.join(" ; "));
});

test("a root write in a spelling the guard cannot parse is refused, not admitted", async (t) => {
  const at = (base: string, path: string) => `${base}${path}`;
  const a = `/accounts/${ACCOUNT}`;
  for (const path of [
    `/client/v4${a}/Containers/Applications/${RECORDED}`,
    `/client/v4/Accounts/${ACCOUNT}/containers/applications/${RECORDED}`,
    `/client/v4${a}/containers/applications/${RECORDED.toUpperCase()}`,
    `/client/v4${a}/containers//applications/${RECORDED}`,
    `/client/v4${a}/containers/applications//${RECORDED}`,
    `/client/v4${a}//containers/applications/${RECORDED}`,
    `/client/v4${a}/containers/%61pplications/${RECORDED}`,
    `/client/v4${a}/containers/applications%2F${RECORDED}`,
    `/client/v4${a}/containers/applications/${RECORDED};v=1`,
    `/client/v4${a}/containers/applications/${RECORDED}%2Frollouts`,
    `/user/x/client/v4${a}/containers/applications/${RECORDED}`,
  ]) {
    const run = await guarded(
      t,
      { rootApplications: [RECORDED], rootApplicationNames: [NAME] },
      (base) => HttpClient.execute(HttpClientRequest.patch(at(base, path))),
    );
    refusalOf(run.exit);
    assert.deepEqual(run.writes, [], path);
  }
});

test("an admitted write that the server redirects is never re-sent to the root", async (t) => {
  // fetch follows 302/307/308 for a PATCH with the same method and body; the guard checks only the
  // first address.
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request);
    received.push(`${request.method} ${request.url}`);
    if (request.url?.endsWith("/applications/cell-app")) {
      response.statusCode = 307;
      response.setHeader("location", request.url.replace("cell-app", RECORDED));
      return response.end();
    }
    response.setHeader("content-type", "application/json");
    response.end(envelope(root));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install({
          rootApplications: [RECORDED],
          rootApplicationNames: [NAME],
        });
        yield* Effect.exit(
          Containers.updateContainerApplication({
            accountId: ACCOUNT,
            applicationId: "cell-app",
            maxInstances: 2,
          } as Containers.UpdateContainerApplicationRequest).pipe(
            Retry.none,
            credentials(base),
            Effect.provide(FetchHttpClient.layer),
            Effect.provide(guard.layer),
          ),
        );
      }),
    ),
  );
  assert.ok(!received.some((line) => line.includes(RECORDED)), received.join(" ; "));
});

test("a write to the account's registry through fetch is refused; its reads go through", async () => {
  const sent: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    sent.push(`${request.method} ${new URL(request.url).pathname}`);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const manifest = `https://registry.cloudflare.com/v2/${ACCOUNT}/pool/manifests/latest`;
  try {
    const outcomes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const guard = yield* install({});
          const results: string[] = [];
          for (const method of ["PUT", "DELETE", "POST", "PATCH", "GET", "HEAD"])
            results.push(
              yield* Effect.promise(() =>
                guard.fetch(manifest, { method }).then(
                  (response) => `${method} sent ${response.status}`,
                  (error: unknown) =>
                    error instanceof WireRefused ? `${method} refused` : String(error),
                ),
              ),
            );
          return results;
        }),
      ),
    );
    assert.deepEqual(outcomes, [
      "PUT refused",
      "DELETE refused",
      "POST refused",
      "PATCH refused",
      "GET sent 200",
      "HEAD sent 200",
    ]);
    assert.deepEqual(sent, [
      `GET /v2/${ACCOUNT}/pool/manifests/latest`,
      `HEAD /v2/${ACCOUNT}/pool/manifests/latest`,
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
