import { onServedFramework } from "./framework.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { aws } from "./aws/index.ts";
import { mergeFeed } from "./feed.ts";
import { handleCatalog } from "./worker.ts";

const sourceBytes = readFileSync(new URL("./aws/source.json", import.meta.url));
const source: { package: string; files: { path: string; content: string }[] } = JSON.parse(
  sourceBytes.toString("utf8"),
);
const provenance: {
  kind: string;
  upstreamIssue: string;
  sourceSha256: string;
  dependencies: Record<string, string>;
} = JSON.parse(readFileSync(new URL("./aws/provenance.json", import.meta.url), "utf8"));

test("AWS catalog provenance pins the self-contained published source and dependencies", () => {
  assert.equal(provenance.kind, "new-app-contribution");
  assert.match(
    provenance.upstreamIssue,
    /^https:\/\/github\.com\/UsefulSoftwareCo\/executor\/issues\/\d+$/,
  );
  assert.equal(provenance.sourceSha256, createHash("sha256").update(sourceBytes).digest("hex"));
  assert.equal(source.package, "aws");
  assert.deepEqual(source.files.map((file) => file.path).sort(), [
    "README.md",
    "connection.ts",
    "errors.ts",
    "icon.ts",
    "identity-client.ts",
    "identity-http.ts",
    "identity-schema.ts",
    "identity-state.ts",
    "index.ts",
    "migrations/0001_identity_center.sql",
    "operations.ts",
    "package.json",
    "provider.ts",
    "requirements.ts",
    "safe-result.ts",
    "saved-connection.ts",
    "session-store.ts",
    "ui/access-check.tsx",
    "ui/api.ts",
    "ui/app.tsx",
    "ui/assets.d.ts",
    "ui/connection-state.ts",
    "ui/connection.tsx",
    "ui/controls.tsx",
    "ui/host.ts",
    "ui/index.html",
    "ui/inventory.tsx",
    "ui/main.tsx",
    "ui/model.ts",
    "ui/style.css",
    "vendor/LICENSE",
    "vendor/aws4fetch.d.ts",
    "vendor/aws4fetch.js",
    "wire.ts",
  ]);

  const manifestFile = source.files.find((file) => file.path === "package.json");
  assert.ok(manifestFile);
  const manifest = JSON.parse(manifestFile.content);
  assert.equal(manifest.name, "aws");
  assert.equal(source.package, "aws");
  assert.equal(manifest.private, true);
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.dependencies, {
    apps: "0.0.1-beta.104-basalt.12",
    "@modelcontextprotocol/sdk": "1.32.1",
    react: "19.2.0",
    "react-dom": "19.2.0",
  });
  assert.deepEqual(provenance.dependencies, manifest.dependencies);
});

test("AWS catalog offers Identity Center and retains managed OAuth and its vendor icon", () => {
  const feed = mergeFeed({ version: 1, apps: [] }, [aws]);
  const entry = feed.apps.find((app) => app.id === "aws");

  assert.ok(entry);
  assert.equal(entry.package, "aws");
  assert.deepEqual(entry.auth, [
    { method: "identityCenter", kind: "interactive", label: "AWS IAM Identity Center" },
    { method: "oauth", kind: "oauth2" },
  ]);
  assert.equal(entry.connectionNotices, undefined);
  assert.equal(entry.icons.length, 2);
  assert.match(entry.icons[0]!.src, /^data:image\/png;base64,/);
});

test("the AWS source route serves the pinned source and the index includes its catalog entry", async () => {
  let publisherCalls = 0;
  const noPublisher: typeof fetch = async () => {
    publisherCalls++;
    return Response.json({ version: 1, apps: [] });
  };

  const sourceResponse = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/aws.json"),
    noPublisher,
  );
  assert.equal(sourceResponse.status, 200);
  assert.deepEqual(
    await sourceResponse.json(),
    JSON.parse(onServedFramework(JSON.stringify(source))),
  );
  assert.equal(publisherCalls, 0);

  const indexResponse = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/index.json"),
    noPublisher,
  );
  const feed: { apps: { id: string; source: string }[] } = await indexResponse.json();
  const entry = feed.apps.find((app) => app.id === "aws");
  assert.equal(indexResponse.status, 200);
  assert.ok(entry);
  assert.equal(entry.source, "apps/aws.json");
  assert.equal(publisherCalls, 1);
});

test("AWS signer sends HTTP only through the supplied context fetch", async () => {
  const vendor = source.files.find((file) => file.path === "vendor/aws4fetch.js");
  assert.ok(vendor);
  const { AwsClient } = await import(
    `data:text/javascript;base64,${Buffer.from(vendor.content).toString("base64")}`
  );
  const requests: Request[] = [];
  const contextFetch: typeof fetch = async (input) => {
    assert.ok(input instanceof Request);
    requests.push(input);
    return new Response("host response", { status: 202 });
  };
  const client = new AwsClient({
    accessKeyId: "ASIASYNTHETIC",
    secretAccessKey: "synthetic-secret",
    sessionToken: "synthetic-session",
    service: "aws-mcp",
    region: "us-east-1",
    fetch: contextFetch,
    retries: 0,
  });
  const response = await client.fetch("http://127.0.0.1:0/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"method":"tools/list"}',
  });
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "host response");
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
  assert.equal(requests[0]!.headers.get("x-amz-security-token"), "synthetic-session");
  assert.equal(await requests[0]!.text(), '{"method":"tools/list"}');
});
