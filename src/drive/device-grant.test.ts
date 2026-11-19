// A device's sync takes the host's own path to its vault: the hosted MCP backend's tool call, the
// SDK's tool call and drive host, the cloud drive backend and the vault object. The app's code, the
// Durable Object hop and the Artifacts control plane are stand-ins; the Git data plane is real.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { GrantId } from "@executor-js/mcp-auth";
import {
  BuildId,
  OwnerId,
  ToolName,
  createExecutor,
  makeExecutorStorage,
  runtimeAdapter,
} from "@executor-js/sdk/core";
import { memoryBlobStore } from "@executor-js/sdk/blobs";
import { memoryRepositories } from "@executor-js/sdk/testing";
import { pgliteLayer } from "fumadb-effect/pglite";
import { fullAuthority } from "../../.upstream/packages/authorization/src/index.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import { CurrentAuthorization } from "../../.upstream/apps/hosted/server/src/contracts/authorization.ts";
import { HostedExecutor } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { CurrentMcpGrant } from "../../.upstream/apps/hosted/server/src/contracts/mcp.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { hostedMcpBackend } from "../../.upstream/apps/hosted/server/src/implementation/mcp.ts";
import { cloudVaultDrives } from "../../.upstream/apps/hosted/cloud/src/infrastructure/artifacts-tokens.ts";
import { storageFixture } from "./fixture.ts";
import { vaultObject, type ArtifactsNamespace } from "./object.ts";
import { backend, git, token } from "./artifacts/test/backend.ts";

const owner = OwnerId.make("fixture-owner"),
  organization = OrganizationId.make("org_device_sync"),
  person = "user-person",
  mac = GrantId.make("grant-mac"),
  phone = GrantId.make("grant-phone");
// The plugin's heartbeat: a one-entry listing at the start of every pull and checkpoint.
const heartbeat = { operation: "drive", method: "list", input: { limit: 1 } } as const;
const unused = () => Effect.die(new Error("the device sync reached an unrelated host capability"));
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  digest: (algorithm, data) =>
    Effect.succeed(
      new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest()),
    ),
});

const artifactsOf = (server: Awaited<ReturnType<typeof backend>>): ArtifactsNamespace => ({
  create: async () => ({ remote: server.url }),
  get: async () => ({
    info: async () => ({ remote: server.url }),
    createToken: async (_scope, ttl) => ({
      plaintext: token,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    }),
    async readBlob(oid) {
      try {
        return new Blob([git(server.bare, "cat-file", "blob", oid)]);
      } catch {
        return null;
      }
    },
  }),
});

test("a device's sync through the hosted MCP backend is recorded under its grant, never its user", async (t) => {
  const server = await backend(),
    data = storageFixture();
  t.after(() => server.close());
  t.after(() => data.close());
  let clock = Date.parse("2026-11-18T09:00:00Z");
  const vaults = new Map<string, ReturnType<typeof vaultObject>>();
  const vaultOf = (app: string) => {
    let vault = vaults.get(app);
    if (!vault) {
      vault = vaultObject({
        app,
        storage: data.storage,
        bucket: data.bucket,
        artifacts: artifactsOf(server),
        now: () => clock,
      });
      vaults.set(app, vault);
    }
    return vault;
  };
  // The Durable Object hop: the coordinator class hands a vault command to its vault object.
  const coordinator = {
    getByName: () => ({
      vault: (app: string, command: unknown, identity?: unknown) =>
        Effect.promise(() => vaultOf(app).request(command, identity)),
    }),
  } as unknown as Parameters<typeof cloudVaultDrives>[0];
  // An app whose one tool makes the plugin's heartbeat through the drive host the SDK hands it.
  const runtime = runtimeAdapter({
    build: () =>
      Effect.succeed({
        build: BuildId.make("bld_device_sync"),
        requirements: { drive: true as const, accounts: { app: {}, user: {} } },
      }),
    skills: unused,
    inspect: unused,
    index: unused,
    query: unused,
    mutate: unused,
    webhook: unused,
    workflow: unused,
    mcpApp: unused,
    call: (input) => {
      const drive = input.workflowControls?.drive;
      return drive === undefined ? unused() : drive(heartbeat).pipe(Effect.orDie);
    },
    connect: unused,
    checkAccount: unused,
    migrate: unused,
  });
  const devices = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const database = yield* makeExecutorStorage({ provider: "postgresql" });
        yield* database.migrate;
        // The hosted policy rows a tool call reads: the caller's membership and the app's audience.
        for (const ddl of [
          'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
          "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
          "create table hosted_app_groups (app_id text, group_id text)",
          "create table hosted_group_members (group_id text, member_id text)",
          "create table hosted_tool_availability (organization_id text, app_id text, definition jsonb)",
        ])
          yield* sql.unsafe(ddl);
        const executor = yield* createExecutor({
          database,
          secret: Redacted.make("b".repeat(64)),
          git: memoryRepositories(),
          blobs: memoryBlobStore(),
          runtime,
          drives: cloudVaultDrives(coordinator),
        });
        const { app } = yield* executor.apps.deploy({
          owner,
          name: "Device sync",
          files: [{ path: "index.ts", content: "export default {};\n" }],
        });
        yield* sql`insert into member values ('member-person', ${organization}, ${person}, 'member')`;
        yield* sql`insert into hosted_app_access values (${app.id}, ${organization}, ${person}, 'everyone', 'revision-1')`;
        const sync = {
          app: app.id,
          tool: ToolName.make("sync"),
          kind: "query" as const,
          input: {},
        };
        // The MCP transport builds the backend for one authenticated request, then runs its calls.
        const mcp = yield* hostedMcpBackend.pipe(
          Effect.provideService(HostedExecutor, Effect.succeed(executor)),
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentOrganization, { organization, owner, role: "member" }),
          Effect.provideService(CurrentAuthorization, fullAuthority),
          Effect.provideService(CurrentUserId, person),
          Effect.provideService(CurrentMcpGrant, mac),
        );
        const synced = yield* mcp.callTool(sync);
        assert.equal(synced.status, "completed", JSON.stringify(synced));
        // A Connect Obsidian connection runs as the app, with no caller, and is a device all the same.
        clock += 1000;
        const appScope = yield* executor.tools
          .call({ ...sync, accounts: { app: {} } })
          .pipe(Effect.provideService(CurrentMcpGrant, phone));
        assert.equal(appScope.status, "completed", JSON.stringify(appScope));
        // The same person without a device grant, such as a dashboard or API call, is no device.
        clock += 1000;
        const signedIn = yield* executor.tools
          .call(sync)
          .pipe(Effect.provideService(CurrentUserId, person));
        assert.equal(signedIn.status, "completed", JSON.stringify(signedIn));
        return yield* Effect.promise(() =>
          vaultOf(app.id).request({ operation: "drive", method: "devices", input: {} }),
        );
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provideService(Crypto.Crypto, crypto)),
  );
  assert.equal(devices.ok, true, JSON.stringify(devices));
  const recorded = (devices.ok ? devices.value : undefined) as {
    head: string;
    devices: { agent: string; lastSyncAt: string; lastHead: string }[];
  };
  assert.deepEqual(recorded.devices, [
    { agent: phone, lastSyncAt: "2026-11-18T09:00:01.000Z", lastHead: recorded.head },
    { agent: mac, lastSyncAt: "2026-11-18T09:00:00.000Z", lastHead: recorded.head },
  ]);
});
