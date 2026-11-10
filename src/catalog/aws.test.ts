import { onServedFramework } from "./framework.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
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
    "device-url.ts",
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
    "ui/index.html",
    "ui/main.js",
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

test("AWS device sign-in accepts only exact AWS pages in the connection's region", async () => {
  const file = source.files.find((entry) => entry.path === "device-url.ts");
  assert.ok(file);
  const { deviceVerificationUrl } = (await import(
    `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(file.content)).toString("base64")}`
  )) as {
    deviceVerificationUrl: (
      value: string,
      region: string,
      kind: "page" | "complete",
    ) => URL | undefined;
  };
  const accepts = (value: string, kind: "page" | "complete" = "complete") =>
    deviceVerificationUrl(value, "eu-west-1", kind)?.href;

  // Current StartDeviceAuthorization shape from the regional OIDC endpoint (instance id synthetic).
  const portal = "https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/#/device";
  assert.equal(accepts(`${portal}?user_code=ABCD-EFGH`), `${portal}?user_code=ABCD-EFGH`);
  assert.equal(accepts(portal, "page"), portal);
  const hyphenated = "https://ssoins-0a1b2c3d-4e5f-67.eu-west-1.portal.amazonaws.com/#/device";
  assert.equal(accepts(`${hyphenated}?user_code=ABCD-EFGH`), `${hyphenated}?user_code=ABCD-EFGH`);
  assert.equal(
    accepts("https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH"),
    "https://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH",
  );

  for (const lookalike of [
    portal,
    `http://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.us-east-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://evil.ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com.evil.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.co/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.evil.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-short.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d.4e5f6789.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com@evil.com/#/device?user_code=ABCD-EFGH`,
    `https://user:pass@ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com:8443/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/start/#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/?next=x#/device?user_code=ABCD-EFGH`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/#/device?user_code=ABCD&next=x`,
    `https://ssoins-0a1b2c3d4e5f6789.eu-west-1.portal.amazonaws.com/#/elsewhere?user_code=ABCD-EFGH`,
    "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH",
    "https://device.sso.eu-west-1.amazonaws.com.evil.com/?user_code=ABCD-EFGH",
    "https://x.device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH",
    "http://device.sso.eu-west-1.amazonaws.com/?user_code=ABCD-EFGH",
    "https://device.sso.eu-west-1.amazonaws.com@evil.com/?user_code=ABCD-EFGH",
    "not a url",
  ])
    assert.equal(accepts(lookalike), undefined, lookalike);
});
