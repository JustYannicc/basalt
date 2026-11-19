// A device's sync takes the host's own path to its vault: the hosted MCP backend's tool call, the
// SDK's tool call and drive host, the cloud drive backend and the vault object. The app's code, the
// Durable Object hop and the Artifacts control plane are stand-ins; the Git data plane is real.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { Crypto, Effect, Redacted, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { DriveCommand } from "apps/contracts";
import { GrantId } from "@executor-js/mcp-auth";
import { ConnectionId } from "@executor-js/mcp-auth/connections";
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
import { obsidianConnectionInput } from "../../.upstream/apps/hosted/web/src/contracts/obsidian-connection.ts";
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
const devicesCommand = { operation: "drive", method: "devices", input: {} } as const;
const unused = () => Effect.die(new Error("the device sync reached an unrelated host capability"));
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(randomBytes(size)),
  digest: (algorithm, data) =>
    Effect.succeed(
      new Uint8Array(createHash(algorithm.replace("-", "").toLowerCase()).update(data).digest()),
    ),
});
// The hosted policy rows a tool call reads: the caller's membership and the app's audience.
const policyTables = [
  'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
  "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
  "create table hosted_app_groups (app_id text, group_id text)",
  "create table hosted_group_members (group_id text, member_id text)",
  "create table hosted_tool_availability (organization_id text, app_id text, definition jsonb)",
];
// Grant storage: the MCP OAuth plugin's grant and connection models.
const grantTables = [
  'create table "mcpConnection" (id text primary key, "userId" text not null, resource text not null, name text not null, policy text not null, revoked boolean not null default false, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now())',
  'create table "mcpGrant" (id text primary key, "userId" text not null, "clientId" text not null, resource text not null, policy text not null, revoked boolean not null default false, connection text)',
];
// A connection's grant stores no authority of its own; it reads its connection's.
const connectionGrantPolicy = JSON.stringify({ kind: "tools", apps: [], approval: "client" });

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

/** Each app's vault object over a real Git backend, on a clock the test moves. */
const vaultFixture = async (t: TestContext) => {
  const server = await backend(),
    data = storageFixture();
  t.after(() => server.close());
  t.after(() => data.close());
  const clock = { now: Date.parse("2026-11-18T09:00:00Z") };
  const vaults = new Map<string, ReturnType<typeof vaultObject>>();
  const vaultOf = (app: string) => {
    let vault = vaults.get(app);
    if (!vault) {
      vault = vaultObject({
        app,
        storage: data.storage,
        bucket: data.bucket,
        artifacts: artifactsOf(server),
        now: () => clock.now,
      });
      vaults.set(app, vault);
    }
    return vault;
  };
  return { clock, vaultOf };
};

/** An executor over a real database with one drive app, whose one tool sends its input to the drive. */
const hostPath = (vaultOf: (app: string) => ReturnType<typeof vaultObject>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The Durable Object hop: the coordinator class hands a vault command to its vault object.
    const coordinator = {
      getByName: () => ({
        vault: (app: string, command: unknown, identity?: unknown) =>
          Effect.promise(() => vaultOf(app).request(command, identity)),
      }),
    } as unknown as Parameters<typeof cloudVaultDrives>[0];
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
        return drive === undefined
          ? unused()
          : drive(Schema.decodeUnknownSync(DriveCommand)(input.input)).pipe(Effect.orDie);
      },
      connect: unused,
      checkAccount: unused,
      migrate: unused,
    });
    const database = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* database.migrate;
    for (const ddl of [...policyTables, ...grantTables]) yield* sql.unsafe(ddl);
    const executor = yield* createExecutor({
      database,
      secret: Redacted.make("b".repeat(64)),
      git: memoryRepositories(),
      blobs: memoryBlobStore(),
      runtime,
      // Grant storage is the request's own database, as in the cloud's composition.
      drives: cloudVaultDrives(coordinator, Effect.succeed(sql)),
    });
    const { app } = yield* executor.apps.deploy({
      owner,
      name: "Device sync",
      files: [{ path: "index.ts", content: "export default {};\n" }],
    });
    yield* sql`insert into member values ('member-person', ${organization}, ${person}, 'member')`;
    yield* sql`insert into hosted_app_access values (${app.id}, ${organization}, ${person}, 'everyone', 'revision-1')`;
    const tool = (command: typeof DriveCommand.Type, kind: "query" | "mutation" = "query") => ({
      app: app.id,
      tool: ToolName.make("sync"),
      kind,
      input: command,
    });
    /** The MCP transport builds the backend for one request authenticated with `grant`, then calls. */
    const mcp = (grant: GrantId, call: ReturnType<typeof tool>) =>
      Effect.gen(function* () {
        const backend = yield* hostedMcpBackend.pipe(
          Effect.provideService(HostedExecutor, Effect.succeed(executor)),
          Effect.provideService(GroupDatabase, Effect.succeed(sql)),
          Effect.provideService(CurrentOrganization, { organization, owner, role: "member" }),
          Effect.provideService(CurrentAuthorization, fullAuthority),
          Effect.provideService(CurrentUserId, person),
          Effect.provideService(CurrentMcpGrant, grant),
        );
        const result = yield* backend.callTool(call);
        assert.equal(result.status, "completed", JSON.stringify(result));
        return result.status === "completed" ? result.value : null;
      });
    return { sql, executor, app, tool, mcp };
  });

type Devices = {
  head: string;
  devices: { agent: string; lastSyncAt: string; lastHead: string }[];
};

test("a device's sync through the hosted MCP backend is recorded under its grant, never its user", async (t) => {
  const { clock, vaultOf } = await vaultFixture(t);
  const devices = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { executor, app, tool, mcp } = yield* hostPath(vaultOf);
        yield* mcp(mac, tool(heartbeat));
        // A Connect Obsidian connection runs as the app, with no caller, and is a device all the same.
        clock.now += 1000;
        const appScope = yield* executor.tools
          .call({ ...tool(heartbeat), accounts: { app: {} } })
          .pipe(Effect.provideService(CurrentMcpGrant, phone));
        assert.equal(appScope.status, "completed", JSON.stringify(appScope));
        // The same person without a device grant, such as a dashboard or API call, is no device.
        clock.now += 1000;
        const signedIn = yield* executor.tools
          .call(tool(heartbeat))
          .pipe(Effect.provideService(CurrentUserId, person));
        assert.equal(signedIn.status, "completed", JSON.stringify(signedIn));
        return yield* Effect.promise(() => vaultOf(app.id).request(devicesCommand));
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provideService(Crypto.Crypto, crypto)),
  );
  assert.equal(devices.ok, true, JSON.stringify(devices));
  const recorded = (devices.ok ? devices.value : undefined) as Devices;
  assert.deepEqual(recorded.devices, [
    { agent: phone, lastSyncAt: "2026-11-18T09:00:01.000Z", lastHead: recorded.head },
    { agent: mac, lastSyncAt: "2026-11-18T09:00:00.000Z", lastHead: recorded.head },
  ]);
});

test("devices() lists the vault's Connect Obsidian grants, never an agent's grant making the same sync calls", async (t) => {
  const { clock, vaultOf } = await vaultFixture(t);
  const agent = GrantId.make("grant-agent"),
    scoped = GrantId.make("grant-scoped-agent");
  const { listed, recorded } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { sql, app, tool, mcp } = yield* hostPath(vaultOf);
        // Connect Obsidian's connection for this vault, and an agent's own connection to the same app.
        const vault = ConnectionId.make("obsidian-vault"),
          tools = ConnectionId.make("agent-tools");
        const vaultPolicy = JSON.stringify({ apps: obsidianConnectionInput(app, vault).apps });
        const agentPolicy = JSON.stringify({
          apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
        });
        yield* sql`insert into "mcpConnection" (id, "userId", resource, name, policy) values
        (${vault}, ${person}, ${organization}, 'Obsidian · Device sync', ${vaultPolicy}),
        (${tools}, ${person}, ${organization}, 'Agent tools', ${agentPolicy})`;
        // Two devices connected through it, a full-access agent and an agent on its own connection.
        yield* sql`insert into "mcpGrant" (id, "userId", "clientId", resource, policy, connection) values
        (${mac}, ${person}, 'obsidian-plugin', ${organization}, ${connectionGrantPolicy}, ${vault}),
        (${phone}, ${person}, 'obsidian-plugin', ${organization}, ${connectionGrantPolicy}, ${vault}),
        (${agent}, ${person}, 'agent-client', ${organization}, '{"kind":"all"}', null),
        (${scoped}, ${person}, 'agent-client', ${organization}, ${connectionGrantPolicy}, ${tools})`;
        const listing = (yield* mcp(mac, tool(heartbeat))) as { at: string };
        clock.now += 1000;
        yield* mcp(phone, tool(heartbeat));
        // The agent makes every sync call shape: the heartbeat, a change range and an import call.
        clock.now += 1000;
        yield* mcp(agent, tool(heartbeat));
        yield* mcp(
          agent,
          tool({ operation: "drive", method: "changes", input: { from: null, to: listing.at } }),
        );
        const id = "agent-import";
        yield* mcp(
          agent,
          tool(
            {
              operation: "drive",
              method: "planImport",
              input: { id, page: 0, entries: [], final: true },
            },
            "mutation",
          ),
        );
        yield* mcp(
          agent,
          tool(
            { operation: "drive", method: "runImport", input: { id, request: heartbeat } },
            "mutation",
          ),
        );
        yield* mcp(scoped, tool(heartbeat));
        // Disconnecting a device revokes its grant.
        yield* sql`update "mcpGrant" set revoked = true where id = ${phone}`;
        return {
          listed: (yield* mcp(agent, tool(devicesCommand))) as Devices,
          recorded: yield* Effect.promise(() => vaultOf(app.id).request(devicesCommand)),
        };
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.provideService(Crypto.Crypto, crypto)),
  );
  // The vault itself recorded every grant that made a sync call.
  assert.equal(recorded.ok, true, JSON.stringify(recorded));
  assert.deepEqual(
    (recorded.ok ? (recorded.value as Devices) : undefined)?.devices.map((row) => row.agent).sort(),
    [agent, mac, phone, scoped].sort(),
  );
  assert.deepEqual(listed.devices, [
    { agent: mac, lastSyncAt: "2026-11-18T09:00:00.000Z", lastHead: listed.head },
  ]);
});
