import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plaidSource, withPlaidAccess } from "./plaid.ts";
import { onServedFramework } from "./framework.ts";
import { handleCatalog } from "./worker.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bytes = (suffix: string) => readFileSync(new URL(`./plaid.${suffix}`, import.meta.url));
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

test("Plaid's corrected package serves without its publisher and replays exactly", async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/apps/plaid.json"),
    async () => {
      throw new Error("Publisher unavailable");
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(plaidSource))),
  );
  const provenance = JSON.parse(bytes("provenance.json").toString());
  assert.equal(sha(bytes("published.json")), provenance.publishedSha256);
  assert.equal(sha(bytes("json")), provenance.carriedSha256);
  assert.equal(sha(bytes("patch")), provenance.patchSha256);
  const original: typeof plaidSource = JSON.parse(bytes("published.json").toString());
  const directory = mkdtempSync(join(tmpdir(), "plaid-replay-"));
  try {
    for (const file of original.files) writeFileSync(join(directory, file.path), file.content);
    execFileSync("git", ["apply", new URL("./plaid.patch", import.meta.url).pathname], {
      cwd: directory,
    });
    for (const file of plaidSource.files)
      assert.equal(readFileSync(join(directory, file.path), "utf8"), file.content);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Plaid's served handlers preserve old accounts and use native machine tokens", () => {
  const output = execFileSync(
    "bun",
    [new URL("./tests/plaid-runtime.mjs", import.meta.url).pathname, root],
    {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.match(output, /additive provider continuity/);
});

test("Plaid advertises the native method without replacing existing methods", () => {
  const original = {
    id: "plaid",
    package: "@executor.sh/plaid",
    name: "Plaid",
    description: "Fixture",
    auth: [
      { method: "apiKey", kind: "secrets" },
      { method: "oauth", kind: "oauth2" },
    ],
    icons: [],
    source: "apps/plaid.json",
  };
  const unrelated = { ...original, id: "other", package: "@example/other" };
  const next = withPlaidAccess({ version: 1, apps: [original, unrelated] });
  assert.deepEqual(next.apps[0].auth, [
    { method: "clientCredentials", kind: "oauth2", label: "Use Production keys for MCP" },
    ...original.auth,
  ]);
  assert.deepEqual(next.apps[1], unrelated);
  assert.deepEqual(withPlaidAccess(next), next);
  assert.throws(
    () => withPlaidAccess({ version: 1, apps: [{ ...original, package: "@other/plaid" }] }),
    /package changed/,
  );
});
