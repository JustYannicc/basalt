// Deleting an app ends every connection that reached only it, for everyone in the organization,
// and takes it out of connections that reach other apps too. Before, the deleted app's scoped
// connection stayed on Connections as "Unavailable app" with its device still authorized.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, type Context } from "effect";
import { AppId } from "@executor-js/sdk";
import { ConnectionId, type ConnectionApp } from "@executor-js/mcp-auth/connections";
import { HostedExecutor } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { removeApp } from "../../.upstream/apps/hosted/server/src/implementation/apps.ts";
import {
  mcpConnectionStore,
  type McpConnectionApi,
} from "../../.upstream/apps/hosted/server/src/implementation/mcp-oauth.ts";
import { fixture } from "./native-device-fixture.ts";

const resource = "http://localhost:3000/mcp/organization-fixture";
const vault = AppId.make("app_fixture_vault");
const notes = AppId.make("app_fixture_notes");
const entry = (app: AppId): ConnectionApp => ({
  app,
  runsAs: [{ kind: "app" }],
  tools: { kind: "selected", names: [] },
  events: { kind: "selected", names: [] },
});

async function organization() {
  const f = await fixture();
  const store = mcpConnectionStore((run) =>
    Effect.tryPromise({ try: () => run(f.api as unknown as McpConnectionApi), catch: (c) => c }),
  );
  const owner = { userId: f.userId, resource };
  const teammate = { userId: "user_fixture_teammate", resource };
  const connect = (who: typeof owner, id: string, apps: readonly AppId[]) =>
    Effect.runPromise(
      store.create(who, { id: ConnectionId.make(id), name: id, policy: { apps: apps.map(entry) } }),
    );
  await connect(owner, "conn_fixture_vault", [vault]);
  await connect(owner, "conn_fixture_both", [vault, notes]);
  await connect(owner, "conn_fixture_notes", [notes]);
  await connect(teammate, "conn_fixture_teammate", [vault]);
  const removed = { removed: true };
  // Only the removal is called; the connection store under test is real.
  const executor = Effect.succeed({
    apps: { remove: () => Effect.succeed(removed) },
  }) as unknown as Context.Service.Shape<typeof HostedExecutor>;
  const remove = (connections: typeof store) =>
    Effect.runPromise(
      removeApp("organization:fixture" as never, { app: vault }, connections).pipe(
        Effect.provideService(HostedExecutor, executor),
      ),
    );
  const listed = async (who: typeof owner) =>
    Object.fromEntries(
      (await Effect.runPromise(store.list(who))).map((connection) => [
        connection.id,
        connection.policy.apps.map((item) => item.app),
      ]),
    );
  return { ...f, store, owner, teammate, remove, removed, listed };
}

test("deleting an app revokes the connections that reached only it and narrows the rest", async () => {
  using f = await organization();
  assert.equal(await f.remove(f.store), f.removed);
  assert.deepEqual(await f.listed(f.owner), {
    conn_fixture_both: [notes],
    conn_fixture_notes: [notes],
  });
  // A teammate's connection to the deleted app goes too.
  assert.deepEqual(await f.listed(f.teammate), {});
  const revoked = f.db.mcpConnection.filter((row) => row.revoked).map((row) => row.id);
  assert.deepEqual(revoked.sort(), ["conn_fixture_teammate", "conn_fixture_vault"]);
});

test("an app is still deleted when its connections can't be updated", async () => {
  using f = await organization();
  const failing = { ...f.store, forgetApp: () => Effect.die(new Error("storage unavailable")) };
  assert.equal(await f.remove(failing), f.removed);
  // Nothing changed, so the person can still revoke the leftover connection on Connections.
  assert.equal(Object.keys(await f.listed(f.owner)).length, 3);
});
