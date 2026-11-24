import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeFleetConfiguration } from "../../../src/pool/runtime-fleet/configuration.ts";
import { RuntimeFleetState } from "../../../src/pool/runtime-fleet/state.ts";
import { RuntimeProviderReader } from "../../../src/pool/runtime-provider/read.ts";
import { observeBoundProvider } from "../../../src/pool/runtime-provider/observation.ts";
import { handleRuntimeHandoff, type HandoffFleet } from "../../../src/pool/runtime-slots/http.ts";
import { crashNonceKey } from "../../../src/pool/runtime-crash-contract.ts";
import type { SlotIdentity } from "../../../src/pool/runtime-slots/contract.ts";
import { openEnvelope } from "../../../src/pool/token.ts";
import { nativeModelHeader } from "../../../src/pool/native-contract.ts";
import { runtimeHandoffCommandPrefix } from "../../../src/pool/runtime-slots/handoff-command.ts";
import { SlotMemory } from "../../pool-tests/runtime-slot-storage.ts";
import { StorageBookmarks } from "../../../src/pool/storage-bookmark.ts";
import { PoolAcceptanceClient } from "../../pool-acceptance/client.ts";
import type { PoolOperationsTarget } from "../../pool-operations.ts";
import type { DispatchDependencies } from "../dispatch.ts";
import {
  envelope,
  resolvedApplication,
  scriptListItem,
  workerSettings,
} from "./cloudflare-shapes.ts";

export const accountId = "0123456789abcdef0123456789abcdef";
export const worker = "fixture-pool-worker";
const signingKey = "a".repeat(64);
const code = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
const controllerId = "e".repeat(64);
const digestOf = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;
export const colours = {
  blue: { id: "app-blue", namespace: "ns-blue", image: digestOf("1"), input: "blue-input-hash" },
  green: {
    id: "app-green",
    namespace: "ns-green",
    image: digestOf("2"),
    input: "green-input-hash",
  },
};
export const primary: SlotIdentity = {
  format: "pool-runtime-slot-v1",
  controllerId,
  slotId: "legacy",
  applicationId: "app-root",
  applicationVersion: "57",
  instanceId: controllerId,
  imageDigest: digestOf("3"),
  imageInput: "root-input",
  bootId: "primary-boot",
};

async function listen(
  handler: (request: IncomingMessage, body: string) => Response | Promise<Response>,
) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const reply = await handler(request, body);
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    response.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

export interface HarnessOptions {
  /** Boot the pool API stamps on each streamed turn, by call index. */
  boot?: (index: number, fleetEnabled: boolean) => string;
  turnStatus?: number;
  /** Simulates the controller starting a ready cell once the fleet is enabled. */
  startCell?: boolean;
  /** What the Worker's POOL_PROVIDER_OBSERVATION_TOKEN Secrets Store binding returns; null is empty. */
  providerSecret?: string | null;
  /** The acceptance device is outside a dedicated acceptance pool: the lane holds no owner access. */
  deviceOnly?: boolean;
  /** The account the pool's usage records name; a foreign one must fail the usage check. */
  usageAccount?: string;
  /** What the controller's inspect reports for the pool's own usage rollup backfill. */
  usageRollup?: unknown;
  /** What the controller's inspect reports for the pool's own capture-hour counts. */
  captureHours?: unknown;
}

export async function harness(options: HarnessOptions = {}) {
  const cloudflareReads: string[] = [];
  const cloudflare = await listen((request) => {
    const path = new URL(request.url!, "http://local").pathname;
    cloudflareReads.push(path);
    const base = `/client/v4/accounts/${accountId}`;
    if (path === `${base}/workers/scripts`)
      return Response.json(
        envelope([
          {
            ...scriptListItem,
            id: "other-site",
            tags: ["alchemy:stack:basalt", "alchemy:stage:production", "alchemy:id:PublicSite"],
          },
          {
            ...scriptListItem,
            id: worker,
            tags: [
              "alchemy:stack:basalt",
              "alchemy:stage:production",
              "alchemy:id:PoolWorker",
              "alchemy:dos:PoolContainer",
            ],
          },
        ]),
      );
    if (path === `${base}/workers/scripts/${worker}/settings`)
      return Response.json(
        envelope({
          ...workerSettings,
          bindings: [
            ...workerSettings.bindings,
            ...Object.entries({
              POOL_BLUE_APPLICATION_ID: colours.blue.id,
              POOL_BLUE_IMAGE_HASH: colours.blue.input,
              POOL_GREEN_APPLICATION_ID: colours.green.id,
              POOL_GREEN_IMAGE_HASH: colours.green.input,
              POOL_CONTAINER_APPLICATION_ID: primary.applicationId,
              POOL_IMAGE_HASH: primary.imageInput,
            }).map(([name, text]) => ({ name, text, type: "plain_text" })),
          ],
        }),
      );
    const root = {
      id: primary.applicationId,
      namespace: "ns-root",
      image: primary.imageDigest,
      input: primary.imageInput,
    };
    for (const colour of [...Object.values(colours), root])
      if (path === `${base}/containers/applications/${colour.id}`)
        return Response.json(
          envelope({
            ...structuredClone(resolvedApplication),
            id: colour.id,
            account_id: accountId,
            name: `pool-runtime-${colour.id}`,
            ...(colour === root ? { version: 57, instances: 1, max_instances: 1 } : {}),
            configuration: {
              ...structuredClone(resolvedApplication.configuration),
              image: `registry.example/${accountId}/pool@${colour.image}`,
            },
            durable_objects: { namespace_id: colour.namespace },
          }),
        );
    return new Response(null, { status: 404 });
  });

  const storage = new SlotMemory();
  const state = new RuntimeFleetState(storage, 4);
  const bindings = (["blue", "green"] as const).map((color) => ({
    color,
    applicationId: colours[color].id,
    imageInput: colours[color].input,
  }));
  // The controller observes providers exactly as in production; only the host is local.
  const provider = new RuntimeProviderReader("observation-token", (input, init) =>
    fetch(input.replace("https://api.cloudflare.com", cloudflare.origin), init),
  );
  const configuration = new RuntimeFleetConfiguration({
    storage,
    controllerId,
    code,
    bindings: () => bindings,
    legacy: async () => primary,
    occupied: (transaction) => state.inspect(transaction),
    provider,
  });
  const cell: SlotIdentity = {
    format: "pool-runtime-slot-v1",
    controllerId,
    slotId: "runtime-cell-1",
    applicationId: colours.blue.id,
    applicationVersion: "1",
    instanceId: "f".repeat(64),
    imageDigest: colours.blue.image,
    imageInput: colours.blue.input,
    homePeerOrdinal: 1,
    bootId: "cell-boot",
  };
  storage.afterCommit = (draft) => {
    const record = draft.get("runtime-fleet-v1:configuration") as { enabled?: boolean } | undefined;
    if (options.startCell !== false && record?.enabled && !draft.has("runtime-fleet-v1:resources"))
      storage.values.set("runtime-fleet-v1:resources", [
        { target: cell, identity: cell, phase: "ready", active: 0, lastUsedAt: 0 },
      ]);
  };
  const actions: string[] = [];
  const crashes: { kind?: string; identity: SlotIdentity }[] = [];
  const retires: { operationId: string; go: string; key: string }[] = [];
  let restart = 0;
  const enabled = async () => (await configuration.inspect())?.enabled === true;
  const providerRequests: string[] = [];
  const providerSecret = {
    get: async () =>
      options.providerSecret === undefined ? "observation-token" : options.providerSecret,
  };
  // The real controller command handler over the real fleet configuration; only the slot layer is a stub.
  const fleet: HandoffFleet = {
    configure: (operationId, value) => configuration.configure(operationId, value),
    disable: (operationId, digest) => configuration.disable(operationId, digest),
    inspect: async (operationId) => {
      // After a kill: two reads show the cell gone, then a replacement boots in the same instance.
      if (restart > 0 && --restart === 0)
        storage.values.set("runtime-fleet-v1:resources", [
          {
            target: cell,
            identity: { ...cell, bootId: "cell-boot-2" },
            phase: "ready",
            active: 0,
            lastUsedAt: 0,
          },
        ]);
      return {
        permission: await configuration.inspect(operationId),
        resources: await state.inspect(),
        bindings,
        recentEnds: await state.recentEnds(),
      };
    },
    crash: async (command) => {
      crashes.push(command);
      await storage.put(crashNonceKey(command.nonce), { command, status: "returned" });
      storage.values.set("runtime-fleet-v1:resources", [
        { target: cell, identity: cell, phase: "warming", active: 0, lastUsedAt: 0 },
      ]);
      restart = 3;
      return { signalled: true };
    },
    // The controller's own rules are src/pool/runtime-fleet-retire-row.test.ts's; this records the send
    // and leaves the row as the override does: count 0, then retired by upkeep.
    retireRow: async (operationId, go, key) => {
      retires.push({ operationId, go, key });
      const rows = (await state.inspect()).map((row) => ({ ...row, active: 0 }));
      storage.values.set("runtime-fleet-v1:resources", rows);
      return {
        operationId,
        go,
        key,
        ordinal: 1,
        ledger: 6,
        cell: 6,
        ledgerStillMs: 300_000,
        cellStillMs: 2_400_000,
        connections: 0,
      };
    },
    inspectCrash: async (_identity, nonce) => ({
      submission: (await storage.get(crashNonceKey(nonce))) ?? null,
      target: null,
    }),
    // Production's own provider-observe path; only the Cloudflare API host is moved to the fixture.
    observeProvider: async (target, signal) => {
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.cloudflare.com/")) return original(input, init);
        providerRequests.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        return original(url.replace("https://api.cloudflare.com", cloudflare.origin), init);
      };
      try {
        return await observeBoundProvider(providerSecret, target, signal);
      } finally {
        globalThis.fetch = original;
      }
    },
  };
  // The real bookmark rules over a storage double that has the platform's recovery calls.
  const bookmarks = new StorageBookmarks({
    storage: storage as never,
    port: {
      current: async () => `0000002a-00000000-00000000-${"c".repeat(32)}`,
      forTime: async () => `00000005-00000000-00000000-${"c".repeat(32)}`,
      restoreOnNextSession: async () => `00000900-00000000-00000000-${"c".repeat(32)}`,
      abort: () => {},
    },
    afterReply: () => {},
  });
  const slots = {
    slots: {
      inspect: async () => ({
        selection: { epoch: 1, active: { target: primary, identity: primary, fenced: false } },
        policies: [],
        denials: [],
        digest: "f".repeat(64),
        controllerCode: code,
      }),
    },
    // A refused command logs the Home pool counters with it; this double has none to report.
    databasePool: () => null,
    // `inspect` reports the forced-restart clock and `recovery-reset` clears it; this double's is clean.
    recoveryState: async () => ({ restarts: [] }),
    // `inspect` reports how the last replaced primary ended; this double replaced none.
    primaryEnd: async () => null,
    resetRecovery: async () => ({ restarts: [] }),
  } as unknown as Parameters<typeof handleRuntimeHandoff>[1];
  const connect: PoolOperationsTarget["connect"] = async () => ({
    env: {
      POOL_OPERATIONS: {
        fetch: async (request: Request) => {
          const { envelope } = JSON.parse(await request.clone().text()) as { envelope: string };
          const opened = await openEnvelope(signingKey, runtimeHandoffCommandPrefix, envelope);
          actions.push((opened as { action: string }).action);
          return handleRuntimeHandoff(
            request,
            slots,
            code,
            signingKey,
            fleet,
            undefined,
            bookmarks,
            undefined,
            options.usageRollup === undefined ? undefined : async () => options.usageRollup,
            options.captureHours === undefined ? undefined : async () => options.captureHours,
          );
        },
      },
    },
    dispose: async () => {},
  });

  let turns = 0;
  /** How each model call was authorized: the lane's credential, never a bearer. */
  const modelCalls: { call: string; authorization: string | null; assertion: string | null }[] = [];
  /** Every owner-token read of the pool, with the authorization it carried. */
  const poolReads: { path: string; authorization: string | null }[] = [];
  const pool = await listen(async (request) => {
    const path = new URL(request.url!, "http://local").pathname;
    if (path.startsWith("/pool/v1/"))
      poolReads.push({ path, authorization: request.headers.authorization ?? null });
    if (path === "/v1/models" || path === "/v1/chat/completions")
      modelCalls.push({
        call: `${request.method} ${path}`,
        authorization: request.headers.authorization ?? null,
        assertion: (request.headers[nativeModelHeader] as string | undefined) ?? null,
      });
    const isEnabled = await enabled();
    const boot = (index: number) =>
      options.boot?.(index, isEnabled) ?? (isEnabled ? "cell-boot" : "primary-boot");
    const headers = { "X-Signalbox-Pool-Boot": "primary-boot" };
    if (path === "/v1/models") return Response.json({ data: [{ id: "model-a" }] }, { headers });
    if (path === "/pool/v1/pool")
      return Response.json({ isOwner: true, accounts: [{ id: "test-1" }, { id: "test-2" }] });
    if (path === "/pool/v1/usage")
      return Response.json({
        records: [
          {
            id: crypto.randomUUID(),
            account: options.usageAccount ?? "test-1",
            status: "success",
            at: new Date().toISOString(),
          },
        ],
      });
    if (path === "/v1/chat/completions") {
      const index = turns++;
      if (options.turnStatus && isEnabled)
        return new Response(null, { status: options.turnStatus });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "Content-Type": "text/event-stream", "X-Signalbox-Pool-Boot": boot(index) } },
      );
    }
    return new Response(null, { status: 404 });
  });

  const directory = await mkdtemp(join(tmpdir(), "pool-fleet-"));
  const deps = (runDirectory = directory): DispatchDependencies => ({
    cloudflare: { accountId, apiToken: "fixture-token", fetch, origin: cloudflare.origin },
    controller: (name) => ({
      accountId,
      worker: name,
      signingKey,
      code,
      connect,
      directory: runDirectory,
    }),
    acceptance: {
      client: new PoolAcceptanceClient({ origin: pool.origin, delay: async () => {} }),
      credential: async (method, path) => ({ [nativeModelHeader]: `assertion ${method} ${path}` }),
      ...(options.deviceOnly ? {} : { access: { token: "pool-token", owner: "acceptance" } }),
    },
    sleep: async () => {},
    now: Date.now,
    log: () => {},
  });
  return {
    deps,
    modelCalls,
    poolReads,
    actions,
    crashes,
    retires,
    providerRequests,
    storage,
    configuration,
    cloudflareReads,
    directory,
    connect,
    code,
    signingKey,
    cloudflareOrigin: cloudflare.origin,
    close: async () => {
      for (const server of [cloudflare.server, pool.server] as Server[])
        await new Promise((done) => server.close(done));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
