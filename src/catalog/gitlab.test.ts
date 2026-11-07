import { onServedFramework } from "./framework.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleCatalog } from "./worker.ts";
import source from "./gitlab.json" with { type: "json" };
import { gitlabConnectionGuidance, gitlabSource } from "./gitlab.ts";

test("GitLab serves the carried source without contacting the publisher", async () => {
  const noFetch: typeof fetch = async () => {
    throw new Error("Unexpected publisher call");
  };
  const response = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/gitlab.json"),
    noFetch,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    JSON.parse(onServedFramework(JSON.stringify(gitlabSource))),
  );
  const head = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/gitlab.json", { method: "HEAD" }),
    noFetch,
  );
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("GitLab provenance binds the published package, account-site patch and host framework", () => {
  const capture = (name: string) => readFileSync(new URL(name, import.meta.url));
  const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const publishedBytes = capture("./gitlab.published.json");
  const carriedBytes = capture("./gitlab.json");
  const patchBytes = capture("./gitlab.patch");
  const published = JSON.parse(publishedBytes.toString());
  const carried = JSON.parse(carriedBytes.toString());
  const provenance = JSON.parse(capture("./gitlab.provenance.json").toString());

  assert.equal(digest(publishedBytes), provenance.publishedSha256);
  assert.equal(digest(carriedBytes), provenance.carriedSha256);
  assert.equal(digest(patchBytes), provenance.patchSha256);
  assert.equal(published.package, "@executor.sh/gitlab");
  assert.equal(carried.package, published.package);
  assert.deepEqual(
    carried.files.map((file: { path: string }) => file.path),
    [...published.files.map((file: { path: string }) => file.path), "mcp.ts"],
  );
  for (const file of published.files as { path: string; content: string }[])
    assert.equal(digest(file.content), provenance.publishedFileSha256[file.path]);
  for (const file of carried.files as { path: string; content: string }[])
    assert.equal(digest(file.content), provenance.carriedFileSha256[file.path]);

  const temporary = mkdtempSync(join(tmpdir(), "basalt-gitlab-carry-"));
  try {
    for (const file of published.files as { path: string; content: string }[])
      writeFileSync(join(temporary, file.path), file.content);
    execFileSync("git", ["apply", new URL("./gitlab.patch", import.meta.url).pathname], {
      cwd: temporary,
    });
    for (const file of carried.files as { path: string; content: string }[])
      assert.equal(readFileSync(join(temporary, file.path), "utf8"), file.content);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  const manifest = JSON.parse(source.files.find((file) => file.path === "package.json")!.content);
  assert.equal(manifest.dependencies.apps, provenance.appsVersion);
  assert.equal(provenance.license, "Not declared in the published package");
  assert.match(
    source.files.find((file) => file.path === "index.ts")!.content,
    /defaultOrigin: true/,
  );
});

test("GitLab signs in to MCP first and keeps the REST provider for full API access", () => {
  const file = (path: string) => gitlabSource.files.find((item) => item.path === path)!.content;
  const index = file("index.ts");
  assert.match(index, /accounts: \{ signIn: gitlabSignIn\.many\(\), gitlab: gitlab\.many\(\) \}/);
  const rest = index.slice(index.indexOf("const gitlab ="), index.indexOf("const description"));
  // Saved REST accounts keep the exact provider declaration they were created under.
  assert.equal(
    createHash("sha256").update(rest).digest("hex"),
    "1afbf026f17068150d96dcb45b709c7c4e76308919e5fb3733890a4f5d6fe76e",
  );
  assert.match(rest, /scopes: \["api", "read_user"\]/);
  assert.match(rest, /"PRIVATE-TOKEN": account\.fields\.token/);
  assert.doesNotMatch(rest, /mcp/);
  // A signed-in account is routed only to the instance's MCP tools.
  assert.match(
    index,
    /user\?\.accounts\.signIn \?\? \[\]\)\.map\(\(account\) => \(\{\s+id: account\.id,\s+discover: \(\) => signedInRouter/,
  );
  const mcp = file("mcp.ts");
  assert.match(
    mcp,
    /mcp: oauth2\(\{ discover: "https:\/\/gitlab\.com\/api\/v4\/mcp", scopes: \["mcp"\] \}\)/,
  );
  assert.match(mcp, /defaultOrigin: true/);
  assert.equal(
    JSON.parse(file("package.json")).dependencies["@modelcontextprotocol/sdk"],
    "1.32.1",
  );
});

test("GitLab guidance binds exact methods and uses setup pages relative to the selected HTTPS site", () => {
  assert.deepEqual(
    gitlabConnectionGuidance.map((guide) => [guide.requirement, guide.method]),
    [
      ["signIn", "mcp"],
      ["gitlab", "token"],
      ["gitlab", "oauth"],
    ],
  );
  for (const guide of gitlabConnectionGuidance) {
    assert.ok(guide.alternativeLabel);
    const help = "credentials" in guide ? guide.credentials : guide.oauthClient;
    assert.ok(help);
    assert.match(help.link.url, /^\/-\/user_settings\//);
    assert.equal(
      new URL(help.link.url, "https://selected.example.test").origin,
      "https://selected.example.test",
    );
    assert.match(help.note ?? "", /administrator/);
  }
  const [signIn, token, oauth] = gitlabConnectionGuidance;
  assert.ok(signIn && "signIn" in signIn && signIn.signIn);
  assert.match(signIn.signIn.details, /none of the REST API tools/);
  assert.ok(signIn.oauthClient.steps.some((step) => /clear Confidential/.test(step)));
  assert.equal("clientSecret" in (signIn.oauthClient.fields ?? {}), false);
  assert.ok(token && "credentials" in token && token.credentials);
  assert.equal(token.credentials.fields.token.label, "Personal access token");
  assert.ok(token.credentials.steps.some((step) => /api scope/.test(step)));
  assert.ok(oauth && "oauthClient" in oauth && oauth.oauthClient);
  assert.ok(oauth.oauthClient.steps.some((step) => /keep Confidential selected/.test(step)));
});
