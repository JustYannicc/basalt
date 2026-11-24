import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { AlchemyContextLive } from "alchemy/AlchemyContext";
import * as Cloudflare from "alchemy/Cloudflare";
import { isResolved } from "alchemy/Diff";
import { DockerLive } from "alchemy/Docker/Docker";
import { InstanceId } from "alchemy/InstanceId";
import type * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { StackContext } from "alchemy/StackContext";
import { Stage } from "alchemy/Stage";
import { sha256Object } from "alchemy/Util/sha256";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer, Logger, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { failureReport } from "./public-report.ts";
import { liveApplication, RootSettleRefused, rootSettles } from "./root-settle-check.ts";
import {
  accountId,
  applicationId,
  buildContext,
  makePlan,
  pinnedImage,
  productionRows,
  type PlanInput,
} from "./test/plan-fixture.ts";

// Every root node below is Alchemy's own plan of the fixture's stack against production-shaped
// State; the live application is served by a local stand-in, as production answered its read.

type Fields = Record<string, unknown>;
const rootAttr = () => productionRows().PoolContainer!.attr as unknown as Fields;
/**
 * The fixture's recorded production read of the root application. Its configuration is the one
 * the fixture records on the root's row; the environment is what the fixture's root declares
 * (only the account variable Alchemy adds), as production's own root declares none.
 */
const recordedRead = (configuration: Fields = {}, application: Fields = {}) => ({
  success: true,
  errors: [],
  messages: [],
  result: {
    id: applicationId,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    account_id: accountId,
    name: "basalt-production-poolcontainer",
    version: 57,
    scheduling_policy: "default",
    instances: 1,
    max_instances: 1,
    configuration: {
      ...(rootAttr().configuration as Fields),
      environment_variables: [{ name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", value: accountId }],
      ...configuration,
    },
    durable_objects: { namespace_id: "namespace-pool-container" },
    network: { bandwidth_limit_mbps: 250 },
    ...application,
  },
});

/** Answers the application read with `body`; every other request is refused and recorded. */
async function standIn(context: TestContext, body: () => unknown, status = 200) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    const applications = `/accounts/${accountId}/containers/applications`;
    if (request.method === "GET" && request.url === `${applications}/${applicationId}`) {
      response.statusCode = status;
      response.end(JSON.stringify(body()));
      return;
    }
    if (request.method === "GET" && request.url === applications) {
      response.end(JSON.stringify({ success: true, result: [], errors: [], messages: [] }));
      return;
    }
    response.statusCode = 405;
    response.end(
      JSON.stringify({
        success: false,
        errors: [{ code: 10000, message: "stand-in refuses writes" }],
        messages: [],
        result: null,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, requests };
}

const rootOf = async (context: TestContext, input: PlanInput = {}) =>
  (await makePlan(context, { rows: productionRows(), ...input })).plan.resources.PoolContainer as
    | Plan.CRUD
    | undefined;

/** Production's pool Worker records the database command's outcome as a setting. */
const recordsReadiness = () => {
  const rows = productionRows();
  (rows.PoolWorker as unknown as { bindings: { sid: string; data: unknown }[] }).bindings.push({
    sid: "POOL_DATABASE_READY",
    data: { bindings: [{ type: "plain_text", name: "POOL_DATABASE_READY", text: "ready" }] },
  });
  return rows;
};

const check = (node: Plan.CRUD | undefined, base: string, pin = pinnedImage) =>
  Effect.runPromiseExit(
    rootSettles({
      node,
      accountId,
      pin,
      read: liveApplication(Redacted.make("synthetic"), base),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );

const refusal = (exit: Exit.Exit<unknown, unknown>) => {
  assert.ok(Exit.isFailure(exit), "the check passed");
  const error = Cause.squash(exit.cause);
  assert.ok(error instanceof RootSettleRefused, String(error));
  // A refusal is printed into a public log: names only, never a host or an account.
  const { publicText } = failureReport(error);
  for (const text of [publicText, error.message]) {
    assert.ok(!text.includes(accountId), text);
    assert.ok(!text.includes("127.0.0.1"), text);
  }
  return { rule: error.rule, field: error.field };
};

test("an update whose live application equals what the apply would send passes and says so", async (context) => {
  const node = await rootOf(context);
  assert.equal(node?.action, "update", "the old layer's row plans a hash-only update");
  const live = await standIn(context, () => recordedRead());
  const exit = await check(node, live.base);
  assert.ok(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : "");
  assert.match(String(exit.value), /sends reads only/u);
  assert.deepEqual(live.requests, [
    `GET /accounts/${accountId}/containers/applications/${applicationId}`,
  ]);
});

test("one differing field refuses and names that field alone", async (context) => {
  const node = await rootOf(context);
  for (const [field, body] of [
    ["maxInstances", recordedRead({}, { max_instances: 2 })],
    ["schedulingPolicy", recordedRead({}, { scheduling_policy: "regional" })],
    ["constraints", recordedRead({}, { constraints: { regions: ["EEUR"], jurisdiction: "eu" } })],
    ["configuration.observability", recordedRead({ observability: { logs: { enabled: false } } })],
    // A resource read back is named by the declared instance type it should expand from.
    ["configuration.instanceType", recordedRead({ memory_mib: 2048 })],
    ["configuration.environmentVariables", recordedRead({ environment_variables: [] })],
  ] as const) {
    const live = await standIn(context, () => body);
    assert.deepEqual(
      refusal(await check(node, live.base)),
      { rule: "root-apply-modifies", field },
      field,
    );
  }
  // A declared change is named by its declared field.
  const standard = await rootOf(context, { declared: { containerInstanceType: "standard" } });
  const live = await standIn(context, () => recordedRead());
  assert.deepEqual(refusal(await check(standard, live.base)), {
    rule: "root-apply-modifies",
    field: "configuration.instanceType",
  });
  // The fixture's recorded read as served to the plan carries a synthetic setting and the EU
  // placement, neither of which the fixture's root declares.
  const served = await standIn(context, () =>
    recordedRead(
      { environment_variables: [{ name: "POOL_SETTING", value: "synthetic" }] },
      { constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" } },
    ),
  );
  assert.deepEqual(refusal(await check(node, served.base)), {
    rule: "root-apply-modifies",
    field: "configuration.environmentVariables,constraints",
  });
});

test("a readback default the platform fills in counts as equal", async (context) => {
  const node = await rootOf(context);
  const defaults = {
    network: { assign_ipv4: "none", assign_ipv6: "none", mode: "private" },
    command: [],
    entrypoint: [],
    runtime: "firecracker",
  };
  // With every default read back, and with none of them.
  for (const configuration of [
    defaults,
    { network: undefined, command: undefined, entrypoint: undefined, runtime: undefined },
  ]) {
    const live = await standIn(context, () => recordedRead(configuration));
    assert.ok(Exit.isSuccess(await check(node, live.base)), JSON.stringify(configuration));
  }
  // A live capacity of its own is the runtime's, not the declaration's.
  const scaled = await standIn(context, () => recordedRead({}, { instances: 3 }));
  assert.ok(Exit.isSuccess(await check(node, scaled.base)));
  // A value that is not the default still differs.
  for (const [field, configuration] of [
    ["configuration.network", { network: { assign_ipv4: "predefined", mode: "public" } }],
    ["configuration.command", { command: ["sleep", "1"] }],
  ] as const) {
    const live = await standIn(context, () => recordedRead(configuration));
    assert.deepEqual(refusal(await check(node, live.base)), { rule: "root-apply-modifies", field });
  }
});

test("a failed read refuses and names the step", async (context) => {
  const node = await rootOf(context);
  // The SDK retries an authentication error as a transient blip, for seconds; a bad request it
  // does not, and both end in the same refusal.
  const denied = await standIn(
    context,
    () => ({
      success: false,
      errors: [{ code: 7003, message: "Could not route to the application" }],
      messages: [],
      result: null,
    }),
    400,
  );
  assert.deepEqual(refusal(await check(node, denied.base)), {
    rule: "root-read-failed",
    field: "read",
  });
  const gone = await standIn(
    context,
    () => ({
      success: false,
      errors: [{ code: 1609, message: "Container application not found" }],
      messages: [],
      result: null,
    }),
    404,
  );
  assert.deepEqual(refusal(await check(node, gone.base)), {
    rule: "root-read-failed",
    field: "read",
  });
  // An injected reader that fails the same way, with a host in its message, still names none.
  const exit = await Effect.runPromiseExit(
    rootSettles({
      node,
      accountId,
      pin: pinnedImage,
      read: () => Effect.fail(new Error(`connect refused to account-host.example/${accountId}`)),
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  assert.deepEqual(refusal(exit), { rule: "root-read-failed", field: "read" });
});

test("an attachment the plan cannot know yet compares as recorded; a moved one refuses", async (context) => {
  const lane = await rootOf(context, {
    rows: recordsReadiness(),
    declared: { poolWorkerWaitsOnCommand: true },
  });
  assert.ok(lane?.bindings.some((binding) => binding.action === "update"));
  const live = await standIn(context, () => recordedRead());
  assert.ok(Exit.isSuccess(await check(lane, live.base)));
  const moved = await standIn(context, () =>
    recordedRead({}, { durable_objects: { namespace_id: "namespace-elsewhere" } }),
  );
  assert.deepEqual(refusal(await check(lane, moved.base)), {
    rule: "root-apply-recreates",
    field: "durableObjects",
  });
});

const referenceHash = async () =>
  (await Effect.runPromise(sha256Object({ image: pinnedImage, imageName: undefined }))).slice(
    0,
    16,
  );
const otherDigest = `sha256:${"f".repeat(64)}`;
/** The root's row once its recorded hash names the reference, but with another recorded digest. */
const recordedDigestRows = async () => {
  const rows = productionRows();
  const hash = (rows.PoolContainer as unknown as { attr: { hash: Fields } }).attr.hash;
  hash.image = await referenceHash();
  hash.digest = otherDigest;
  return rows;
};

test("the image compared is exactly the one the apply would send", async (context) => {
  // The old layer's hash differs from the reference's: the apply deploys the pin's digest.
  const healing = await rootOf(context);
  const pinned = await standIn(context, () => recordedRead());
  assert.ok(Exit.isSuccess(await check(healing, pinned.base)));
  // While the recorded hash names the reference, the apply keeps the recorded digest instead.
  const node = await rootOf(context, { rows: await recordedDigestRows() });
  assert.equal(node?.action, "update");
  const repository = pinnedImage.slice(0, pinnedImage.indexOf("@"));
  const kept = await standIn(context, () =>
    recordedRead({ image: `${repository}@${otherDigest}` }),
  );
  assert.ok(Exit.isSuccess(await check(node, kept.base)));
  const live = await standIn(context, () => recordedRead());
  assert.deepEqual(refusal(await check(node, live.base)), {
    rule: "root-apply-modifies",
    field: "configuration.image",
  });
});

test("a row the plan check owns is not judged here, and nothing is read", async (context) => {
  const live = await standIn(context, () => recordedRead());
  const node = await rootOf(context);
  assert.ok(node);
  // The apply never reconciles a noop row.
  const noop = { ...node, action: "noop" } as Plan.CRUD;
  const built = await rootOf(context, { declared: { container: { context: buildContext } } });
  for (const [why, root, pin] of [
    ["no row", undefined, pinnedImage],
    ["a noop row", noop, pinnedImage],
    ["another pin", node, pinnedImage.replace(/e{64}$/u, "f".repeat(64))],
    ["a build input", built, pinnedImage],
  ] as const) {
    const exit = await check(root, live.base, pin);
    assert.ok(Exit.isSuccess(exit) && exit.value === undefined, why);
  }
  assert.deepEqual(live.requests, []);
});

/**
 * The provider itself, on the same node: Apply's update hands `reconcile` the node's props, its
 * bindings (here with the recorded attachment, which the plan check proves the apply resolves to)
 * and the row's attributes. It modifies the application exactly when it sends anything but a read.
 */
async function providerModifies(node: Plan.CRUD, base: string, requests: readonly string[]) {
  const state = node.state as unknown as {
    instanceId: string;
    props: unknown;
    attr: unknown;
    bindings: { sid: string; data: unknown }[];
  };
  const recorded = new Map(state.bindings.map(({ sid, data }) => [sid, data]));
  const bindings = node.bindings
    .filter((binding) => binding.action !== "delete")
    .map(({ sid, data }) => ({
      sid,
      data: isResolved(data) ? data : recorded.get(sid),
    }));
  const services = Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.succeed(apiTokenCredentials({ apiToken: "synthetic", apiBaseUrl: base })),
    ),
    Layer.succeed(
      Cloudflare.CloudflareEnvironment,
      Effect.succeed({
        type: "apiToken" as const,
        accountId,
        apiToken: Redacted.make("synthetic"),
        source: { type: "env" as const },
      }),
    ),
    FetchHttpClient.layer,
  );
  const before = requests.length;
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const provider = yield* Provider.Provider("Cloudflare.Container");
      return yield* provider.reconcile({
        id: "PoolContainer",
        fqn: "PoolContainer",
        news: "props" in node ? node.props : {},
        instanceId: state.instanceId,
        bindings,
        session: { note: () => Effect.void },
        olds: state.props,
        output: state.attr,
      } as never);
    }).pipe(
      // What Apply runs every lifecycle under: the stack, its stage and the row's instance.
      Effect.provideService(StackContext, {
        name: "basalt",
        stage: "production",
        resources: {},
        bindings: {},
        actions: {},
      }),
      Effect.provideService(Stage, "production"),
      Effect.provideService(InstanceId, state.instanceId),
      Effect.provide(Logger.layer([])),
      Effect.provide(
        Cloudflare.Containers.LiveContainerProvider().pipe(
          Layer.provideMerge(Layer.mergeAll(services, DockerLive)),
          Layer.provideMerge(AlchemyContextLive.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      ),
    ) as Effect.Effect<unknown, unknown>,
  );
  const sent = requests.slice(before);
  const writes = sent.some((request) => !request.startsWith("GET "));
  // Reads only means the reconcile finished on them; a failure counts only once it sent a write
  // (the stand-in refuses every one), or the provider never reached its decision.
  if (Exit.isSuccess(exit)) assert.ok(!writes, sent.join(", "));
  else
    assert.ok(writes, `the provider stopped before deciding: ${String(Cause.squash(exit.cause))}`);
  assert.ok(
    sent.includes(`GET /accounts/${accountId}/containers/applications/${applicationId}`),
    `the provider did not read the application: ${sent.join(", ")}`,
  );
  return writes;
}

test("the check decides as the provider's own apply does", async (context) => {
  const healing = await rootOf(context);
  const lane = await rootOf(context, {
    rows: recordsReadiness(),
    declared: { poolWorkerWaitsOnCommand: true },
  });
  const kept = await rootOf(context, { rows: await recordedDigestRows() });
  const standard = await rootOf(context, { declared: { containerInstanceType: "standard" } });
  const repository = pinnedImage.slice(0, pinnedImage.indexOf("@"));
  const cases = [
    ["equal", healing, recordedRead()],
    ["readback defaults absent", healing, recordedRead({ network: undefined, command: undefined })],
    ["a live instance count", healing, recordedRead({}, { instances: 3 })],
    ["another maximum", healing, recordedRead({}, { max_instances: 2 })],
    ["placement", healing, recordedRead({}, { constraints: { jurisdiction: "eu" } })],
    ["a command", healing, recordedRead({ command: ["sleep", "1"] })],
    ["a public network", healing, recordedRead({ network: { mode: "public" } })],
    ["another environment", healing, recordedRead({ environment_variables: [] })],
    ["another instance type", standard, recordedRead()],
    ["the attachment waits", lane, recordedRead()],
    [
      "a moved attachment",
      lane,
      recordedRead({}, { durable_objects: { namespace_id: "namespace-elsewhere" } }),
    ],
    ["the recorded digest kept", kept, recordedRead({ image: `${repository}@${otherDigest}` })],
    // Carry 0767: the application keeps the reference it runs when that names the recorded digest.
    [
      "the recorded digest on another repository",
      kept,
      recordedRead({ image: `${repository}-elsewhere@${otherDigest}` }),
    ],
    ["the pin's digest while the recorded one is kept", kept, recordedRead()],
  ] as const;
  const decisions: string[] = [];
  for (const [name, node, body] of cases) {
    assert.ok(node && node.action === "update", name);
    const live = await standIn(context, () => body);
    const ours = Exit.isFailure(await check(node, live.base));
    const theirs = await providerModifies(node, live.base, live.requests);
    decisions.push(`${name}: ${theirs ? "modifies" : "reads only"}`);
    assert.equal(
      ours,
      theirs,
      `${name}: the check refuses ${ours}, the provider modifies ${theirs}`,
    );
  }
  // Both outcomes are exercised, so agreement is not agreement on one answer.
  assert.ok(decisions.some((line) => line.endsWith("modifies")));
  assert.ok(decisions.some((line) => line.endsWith("reads only")));
});
