import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The Mac panel's app list: the device grant reads the organization inventory with discover
 * authority only. Read-level endpoints refuse the same token.
 */
export async function verifyNativeApps({
  worker,
  home,
  storage,
  command,
  app,
  organization,
  owner,
  appsManifest,
  created,
}) {
  const shared = await sharedAccountApp({ worker, organization, owner, appsManifest });
  created.push(shared);
  const summary = JSON.parse((await command(["apps"])).stdout);
  assert.equal(summary.organization, organization);
  const listed = summary.apps.find((entry) => entry.id === app.id);
  assert.deepEqual(listed && { name: listed.name, accounts: listed.accounts }, {
    name: app.name,
    accounts: 0,
  });
  assert.equal(
    summary.apps.find((entry) => entry.id === shared)?.accounts,
    1,
    "An account the owner linked for everyone counts, though the device cannot read accounts.",
  );
  assert.ok(summary.apps.every((entry) => Object.keys(entry).sort().join() === "accounts,id,name"));

  // Only file custody exposes the raw device grant to a test; CI runs on Linux with it.
  if (storage !== "file") return;
  const { accessToken } = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
  const bearer = { authorization: `Bearer ${accessToken}` };
  const read = async (path) => {
    const response = await fetch(`${worker.origin}/api/organizations/${organization}${path}`, {
      headers: bearer,
    });
    await response.body?.cancel();
    return response.status;
  };
  assert.equal(await read("/inventory"), 200, "Discover reads accept the device grant.");
  assert.equal(await read("/resources"), 403, "Read-level account directories refuse it.");
  assert.equal(await read(`/apps/${app.id}/access`), 403, "App access policy reads refuse it.");
}

/** An app whose own requirement the owner fills with one account linked for everyone. */
async function sharedAccountApp({ worker, organization, owner, appsManifest }) {
  const prefix = `${worker.origin}/api/organizations/${organization}`;
  const post = async (path, body) => {
    const response = await fetch(`${prefix}${path}`, {
      method: "POST",
      headers: owner,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, `POST ${path}`);
    return response.json();
  };
  const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = defineProvider({ name: "Native shared account", auth: { key: secrets({ label: "Key", fields: object({ token: string() }) }) } });
export default defineApp({ app: { accounts: { team } } }, { tools: router({ ping: query({ input: object({}) }, async () => ({ ok: true })) }) });`;
  const app = await post("/apps/deploy", {
    name: "Native shared account proof",
    files: [{ path: "index.ts", content: source }, appsManifest],
  });
  const connection = await post(`/apps/${app.id}/accounts/app/team/connections`, {
    destination: { kind: "shared", audience: { kind: "everyone" } },
  });
  await post(`/connections/${connection.id}/submit`, {
    method: "key",
    label: "Shared team account",
    fields: { token: "synthetic-shared-token" },
  });
  return app.id;
}
