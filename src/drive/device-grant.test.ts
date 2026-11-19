// A device's sync takes the host's own path to its vault: the hosted MCP backend's tool call, the
// SDK's tool call and drive host, the cloud drive backend and the vault object. Grant storage is
// written by the grant store itself (see test/grant-fixture.ts). The app's code, the Durable Object hop
// and the Artifacts control plane are stand-ins; the Git data plane is real.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { Cause, Crypto, Effect, Exit, Option, Redacted, Schema, type Scope } from "effect";
import { SqlClient } from "effect/sql";
import { DriveCommand, DriveDevices } from "apps/contracts";
import { GrantId } from "@executor-js/mcp-auth";
import { ConnectionId, type ConnectionInput } from "@executor-js/mcp-auth/connections";
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
import { vaultDevicesOnly } from "../../.upstream/apps/hosted/server/src/implementation/vault-device-grants.ts";
import { storageFixture } from "./fixture.ts";
import { grantStore } from "./test/grant-fixture.ts";
import { vaultObject, type ArtifactsNamespace } from "./object.ts";
import { backend, git, token } from "./artifacts/test/backend.ts";

const owner = OwnerId.make("fixture-owner"),
  organization = OrganizationId.make("org_device_sync");
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
// The hosted policy rows a tool call reads beside membership: the app's audience.
const policyTables = [
  "create table hosted_app_access (id text primary key, organization_id text, creator_id text, audience text, revision text)",
  "create table hosted_app_groups (app_id text, group_id text)",
  "create table hosted_group_members (group_id text, member_id text)",
  "create table hosted_tool_availability (organization_id text, app_id text, definition jsonb)",
];

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
          : Schema.decodeUnknownEffect(DriveCommand)(input.input).pipe(
              Effect.flatMap(drive),
              Effect.orDie,
            );
      },
      connect: unused,
      checkAccount: unused,
      migrate: unused,
    });
    const database = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* database.migrate;
    const grants = yield* grantStore(organization);
    for (const ddl of policyTables) yield* sql.unsafe(ddl);
    // Grant storage is the request's own database, as in the cloud executor's composition.
    const drives = vaultDevicesOnly(cloudVaultDrives(coordinator), Effect.succeed(sql));
    const executor = yield* createExecutor({
      database,
      secret: Redacted.make("b".repeat(64)),
      git: memoryRepositories(),
      blobs: memoryBlobStore(),
      runtime,
      drives,
    });
    const { app } = yield* executor.apps.deploy({
      owner,
      name: "Device sync",
      files: [{ path: "index.ts", content: "export default {};\n" }],
    });
    yield* sql`insert into hosted_app_access values (${app.id}, ${organization}, ${grants.userId}, 'everyone', 'revision-1')`;
    const tool = (command: Schema.Json, kind: "query" | "mutation" = "query") => ({
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
          Effect.provideService(CurrentUserId, grants.userId),
          Effect.provideService(CurrentMcpGrant, grant),
        );
        const result = yield* backend.callTool(call);
        assert.equal(result.status, "completed", JSON.stringify(result));
        return result.status === "completed" ? result.value : null;
      });
    return { sql, executor, drives, grants, app, tool, mcp };
  });

const devicesOf = (value: unknown) =>
  Schema.decodeUnknownEffect(DriveDevices)(value).pipe(Effect.orDie);
const listingOf = (value: unknown) =>
  Schema.decodeUnknownEffect(Schema.Struct({ at: Schema.String }))(value).pipe(Effect.orDie);
const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient.SqlClient | Crypto.Crypto | Scope.Scope>,
) =>
  Effect.runPromise(
    Effect.scoped(effect).pipe(
      Effect.provide(pgliteLayer()),
      Effect.provideService(Crypto.Crypto, crypto),
    ),
  );

test("a device's sync through the hosted MCP backend is recorded under its grant, never its user", async (t) => {
  const { clock, vaultOf } = await vaultFixture(t);
  const mac = GrantId.make("grant-mac"),
    phone = GrantId.make("grant-phone");
  const devices = await run(
    Effect.gen(function* () {
      const { executor, grants, app, tool, mcp } = yield* hostPath(vaultOf);
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
        .pipe(Effect.provideService(CurrentUserId, grants.userId));
      assert.equal(signedIn.status, "completed", JSON.stringify(signedIn));
      return yield* Effect.promise(() => vaultOf(app.id).request(devicesCommand));
    }),
  );
  assert.ok(devices.ok, JSON.stringify(devices));
  const recorded = await Effect.runPromise(devicesOf(devices.value));
  assert.deepEqual(recorded.devices, [
    { agent: phone, lastSyncAt: "2026-11-18T09:00:01.000Z", lastHead: recorded.head },
    { agent: mac, lastSyncAt: "2026-11-18T09:00:00.000Z", lastHead: recorded.head },
  ]);
});

/** An agent's own connection to the vault app, run as the app, with the tools it chose. */
const agentConnection = (
  app: { readonly id: ConnectionInput["apps"][number]["app"] },
  id: string,
  tools: ConnectionInput["apps"][number]["tools"],
): ConnectionInput => ({
  id: ConnectionId.make(id),
  name: `Agent ${id}`,
  apps: [{ app: app.id, runsAs: [{ kind: "app" }], tools }],
});

test("devices() lists the vault's Connect Obsidian devices, never an agent's grant making the same sync calls", async (t) => {
  const { clock, vaultOf } = await vaultFixture(t);
  const { listed, recorded, ids } = await run(
    Effect.gen(function* () {
      const { grants, app, tool, mcp } = yield* hostPath(vaultOf);
      // Connect Obsidian's connection for this vault; two devices connect through it.
      const vault = yield* grants.connection(
        obsidianConnectionInput(app, ConnectionId.make("obsidian-vault")),
      );
      const mac = yield* grants.connectDevice(vault, "MacBook");
      const phone = yield* grants.connectDevice(vault, "iPhone");
      // An earlier Connect Obsidian connection, which the person revokes below.
      const earlier = ConnectionId.make("obsidian-earlier");
      const tablet = yield* grants.connectDevice(
        yield* grants.connection(obsidianConnectionInput(app, earlier)),
        "iPad",
      );
      // Agents: full access, their own connection with every tool, one with only listNotes and
      // readNote, and one connected through Connect Obsidian's own connection, which holds exactly
      // a device's access. Only how each grant was issued tells them from a device.
      const agent = yield* grants.connectAgent(grants.mcpUrl, "Agent");
      const borrower = yield* grants.connectAgent(vault.url, "Agent");
      const scoped = yield* grants.connectAgent(
        (yield* grants.connection(agentConnection(app, "agent-tools", { kind: "all" }))).url,
        "Agent",
      );
      const reader = yield* grants.connectAgent(
        (yield* grants.connection(
          agentConnection(app, "vault-reader", {
            kind: "selected",
            names: [ToolName.make("listNotes"), ToolName.make("readNote")],
          }),
        )).url,
        "Reader",
      );
      const listing = yield* listingOf(yield* mcp(mac, tool(heartbeat)));
      clock.now += 1000;
      yield* mcp(phone, tool(heartbeat));
      yield* mcp(tablet, tool(heartbeat));
      // The agents make every sync call shape their tools allow: the heartbeat, which is a listing,
      // a change range and import calls.
      clock.now += 1000;
      const changes = {
        operation: "drive",
        method: "changes",
        input: { from: null, to: listing.at },
      };
      yield* mcp(reader, tool(heartbeat));
      for (const grant of [agent, scoped, borrower]) {
        yield* mcp(grant, tool(heartbeat));
        yield* mcp(grant, tool(changes));
      }
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
      // Disconnecting a device revokes its grant; revoking a connection ends every grant through it.
      yield* grants.revokeGrant(phone);
      yield* grants.revokeConnection(earlier);
      return {
        ids: { mac, phone, tablet, agent, borrower, scoped, reader },
        listed: yield* devicesOf(yield* mcp(agent, tool(devicesCommand))),
        recorded: yield* Effect.promise(() => vaultOf(app.id).request(devicesCommand)),
      };
    }),
  );
  // The vault itself recorded every grant that made a sync call.
  assert.ok(recorded.ok, JSON.stringify(recorded));
  assert.deepEqual(
    (await Effect.runPromise(devicesOf(recorded.value)))
      .devices.map((row) => row.agent)
      .sort(),
    Object.values(ids).sort(),
  );
  assert.deepEqual(listed.devices, [
    { agent: ids.mac, lastSyncAt: "2026-11-18T09:00:00.000Z", lastHead: listed.head },
  ]);
});

test("devices() fails when it cannot read a grant's record, rather than leave a device out", async (t) => {
  const { vaultOf } = await vaultFixture(t);
  const exit = await run(
    Effect.gen(function* () {
      const { sql, drives, grants, app, tool, mcp } = yield* hostPath(vaultOf);
      const vault = yield* grants.connection(
        obsidianConnectionInput(app, ConnectionId.make("obsidian-vault")),
      );
      yield* mcp(yield* grants.connectDevice(vault, "MacBook"), tool(heartbeat));
      // A policy this reader cannot decode, as an unannounced change to the record could leave it.
      yield* sql`update "mcpConnection" set policy = ${JSON.stringify({ apps: [{ app: app.id }] })} where id = ${vault.id}`;
      return yield* drives
        .request({ app: app.id, build: "bld_device_sync", command: devicesCommand })
        .pipe(Effect.exit);
    }),
  );
  assert.ok(Exit.isFailure(exit), `devices() answered ${JSON.stringify(exit)}`);
  const failure = Cause.findErrorOption(exit.cause);
  assert.equal(Option.isSome(failure) ? failure.value.reason : undefined, "integrity");
});
