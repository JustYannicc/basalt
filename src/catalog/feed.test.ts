import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeFeed, type Feed } from "./feed.ts";
import { handleCatalog } from "./worker.ts";
import sourceSnapshot from "./zendesk/source.json" with { type: "json" };
import sourceProvenance from "./zendesk/provenance.json" with { type: "json" };
import { zendeskAddition } from "./zendesk/source.ts";

const official: Feed = {
  version: 1,
  apps: [{ id: "gmail", package: "@example/gmail", name: "Gmail", description: "Mail", auth: [], icons: [{ src: "icons/gmail.png" }], source: "apps/gmail.json" }],
};

test("the hosted feed preserves official entries and resolves their icons", () => {
  const feed = mergeFeed(official);
  assert.equal(feed.apps[0]!.package, official.apps[0]!.package);
  assert.equal(feed.apps[0]!.icons[0]!.src, "https://catalog.executor.sh/icons/gmail.png");
  assert.equal(official.apps[0]!.icons[0]!.src, "icons/gmail.png");
  const addition = { entry: { ...official.apps[0]!, id: "other", package: "@example/other" }, source: { package: "@example/other", files: [] } };
  assert.equal(mergeFeed(official, [addition]).apps.length, 2);
  assert.throws(() => mergeFeed(official, [addition, addition]), /duplicates/);
  assert.throws(() => mergeFeed(official, [{ ...addition, source: { package: "wrong", files: [] } }]), /package mismatch/);
});

test("publisher requests are read-only and never receive person credentials", async () => {
  let calls = 0;
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json?private=value", {
    headers: { Authorization: "Bearer fixture", Cookie: "session=fixture" },
  }), async (input, init) => {
    calls++;
    assert.equal(String(input), "https://catalog.executor.sh/index.json");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("authorization"), null);
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    return Response.json(official);
  });
  assert.equal(calls, 1);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).apps[0].id, "gmail");
});

test("source reads preserve official app bytes and never follow redirects", async () => {
  const document = '{"package":"@example/gmail","files":[]}';
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/gmail.json"), async input => {
    assert.equal(String(input), "https://catalog.executor.sh/apps/gmail.json");
    return new Response(document);
  });
  assert.equal(await response.text(), document);
  const moved = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => new Response(null, { status: 302, headers: { Location: "https://example.invalid" } }));
  assert.equal(moved.status, 502);
  assert.equal(moved.headers.get("cache-control"), "no-store");
});

test("unknown paths and writes never contact the publisher; failures are safe", async () => {
  const noFetch: typeof fetch = async () => { throw new Error("unexpected fetch"); };
  for (const path of ["/catalog/", "/catalog/apps/a%2fb.json", "/catalog/icons/mail.png", "/index.json"])
    assert.equal((await handleCatalog(new Request(`https://app.signalbox.run${path}`), noFetch)).status, 404);
  assert.equal((await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json", { method: "POST" }), noFetch)).status, 405);
  const failed = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => { throw new Error("private response"); });
  assert.equal(failed.status, 502);
  assert.equal(await failed.text(), '{"error":"Catalog unavailable"}');
  const malformed = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => Response.json({ version: 2, apps: [] }));
  assert.equal(malformed.status, 502);
});

test("HEAD has GET headers with no body", async () => {
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json", { method: "HEAD" }), async () => Response.json(official));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.text(), "");
});


test("provider restrictions follow the actual official app names and never change auth", () => {
  const apps = [
    ["gmail", "Gmail"], ["google-calendar", "Google Calendar"], ["google-drive", "Google Drive"],
    ["google-docs", "Google Docs"], ["google-sheets", "Google Sheets"], ["google-slides", "Google Slides"],
    ["github", "GitHub"], ["slack", "Slack"],
  ].map(([id, name]) => ({ ...official.apps[0]!, id: id!, name: name!, package: `@executor.sh/${id}`, auth: [{ method: "oauth", kind: "oauth2" }] }));
  const feed = mergeFeed({ version: 1, apps });
  for (const [index, entry] of feed.apps.entries()) {
    assert.equal(entry.connectionNotices?.[0]?.providerName, apps[index]!.name);
    assert.deepEqual(entry.auth, apps[index]!.auth);
  }
  assert.match(feed.apps[0]!.connectionNotices![0]!.message, /100 users over its lifetime/);
  assert.match(feed.apps[7]!.connectionNotices![0]!.message, /not one-click yet/);
  assert.match(feed.apps[7]!.connectionNotices![0]!.message, /bot token/);
  assert.equal(apps[0]!.connectionNotices, undefined);
});

test("the public feed marks only unconfigured hosted connectors as not set up yet", async () => {
  const feed: Feed = { version: 1, apps: ["gmail", "google-drive", "github"].map(id => ({ ...official.apps[0]!, id,
    name: id, package: `@executor.sh/${id}` })) };
  for (const ready of [{ google: false, github: false }, { google: true, github: false }, { google: false, github: true }, { google: true, github: true }]) {
    const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => Response.json(feed), ready);
    assert.equal(response.status, 200);
    const result = await response.json() as Feed;
    for (const source of feed.apps) {
      const entry = result.apps.find(item => item.id === source.id)!;
      const configured = entry.id === "github" ? ready.github : ready.google;
      assert.equal(entry.connectionNotices?.some(notice => notice.message.includes("not set up yet")), !configured);
      assert.deepEqual(entry.auth, source.auth);
    }
  }
});


test("ElevenLabs uses its official personal API-key app without hosted-client readiness", async () => {
  const entry = { ...official.apps[0]!, id: "elevenlabs", package: "@executor.sh/elevenlabs", name: "ElevenLabs",
    auth: [{ method: "apiKey", kind: "secrets", label: "API key" }] };
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => Response.json({ version: 1, apps: [entry] }));
  const result = (await response.json() as Feed).apps[0]!;
  assert.deepEqual(result.auth, entry.auth);
  assert.equal(result.source, "apps/elevenlabs.json");
  assert.match(result.connectionNotices![0]!.message, /your own ElevenLabs account/);
  assert.match(result.connectionNotices![0]!.message, /secure connection form/);
  assert.doesNotMatch(result.connectionNotices![0]!.message, /not set up yet/);
  const source = '{"package":"@executor.sh/elevenlabs","files":[]}';
  assert.equal(await (await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/elevenlabs.json"), async () => new Response(source))).text(), source);
});

test("Zendesk source snapshot matches its provenance digests", () => {
  const snapshotBytes = readFileSync(new URL("./zendesk/source.json", import.meta.url));
  assert.equal(
    createHash("sha256").update(snapshotBytes).digest("hex"),
    sourceProvenance.snapshotSha256,
  );
  assert.equal(sourceSnapshot.package, "@signalbox/zendesk");
  assert.equal(sourceProvenance.package, sourceSnapshot.package);
  const catalogHashes = sourceProvenance.catalogFileSha256 as Record<string, string>;
  for (const file of sourceSnapshot.files) {
    assert.equal(
      createHash("sha256").update(file.content).digest("hex"),
      catalogHashes[file.path],
      file.path,
    );
  }
  assert.equal(sourceProvenance.tenantTemplate.setting, "EXECUTOR_ZENDESK_SUBDOMAIN");
  assert.equal(sourceProvenance.tenantTemplate.marker, "example");
});

test("Zendesk appears only for trusted configuration and its source cannot take a tenant from the request", async () => {
  const trustedTenant = "synthetic-tenant";
  const requestTenant = "untrusted-tenant";
  const ready = { google: false, github: false, zendesk: true };
  const response = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/index.json?tenant=" + requestTenant),
    async input => {
      assert.equal(String(input), "https://catalog.executor.sh/index.json");
      return Response.json(official);
    },
    ready,
    trustedTenant,
  );
  assert.equal(response.status, 200);
  const feed = await response.json() as Feed;
  const entry = feed.apps.find(app => app.id === "zendesk");
  assert.ok(entry);
  assert.equal(entry.package, "@signalbox/zendesk");
  assert.equal(entry.source, "apps/zendesk.json");
  assert.deepEqual(entry.auth, [{ method: "oauth", kind: "oauth2" }]);
  const notice = entry.connectionNotices?.[0]?.message ?? "";
  assert.match(notice, /Signalbox/);
  assert.doesNotMatch(notice, /synthetic-tenant|untrusted-tenant|CLIENT_ID|CLIENT_SECRET|.zendesk.com/);

  const sourceResponse = await handleCatalog(
    new Request(
      "https://app.signalbox.run/catalog/apps/zendesk.json?tenant=" + requestTenant,
    ),
    async () => {
      throw new Error("the configured source must be served locally");
    },
    ready,
    trustedTenant,
  );
  assert.equal(sourceResponse.status, 200);
  const source = await sourceResponse.json() as {
    package: string;
    files: { path: string; content: string }[];
  };
  assert.equal(source.package, entry.package);
  const index = source.files.find(file => file.path === "index.ts")?.content ?? "";
  assert.match(index, /createZendeskApp\("synthetic-tenant"\)/);
  assert.doesNotMatch(index, /untrusted-tenant|example/);
  assert.equal(
    source.files.find(file => file.path === "configuration.ts")?.content,
    sourceSnapshot.files.find(file => file.path === "configuration.ts")?.content,
  );

  const unavailable = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/index.json"),
    async () => Response.json(official),
    { google: false, github: false, zendesk: false },
    trustedTenant,
  );
  assert.equal(
    ((await unavailable.json()) as Feed).apps.some(app => app.id === "zendesk"),
    false,
  );
  const unavailableSource = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/apps/zendesk.json"),
    async () => new Response(null, { status: 404 }),
    { google: false, github: false, zendesk: false },
    trustedTenant,
  );
  assert.equal(unavailableSource.status, 404);
  assert.throws(() => zendeskAddition("two.labels"), /one lowercase DNS label/);
});

test("Zoho CRM readiness stays independent and keeps the official regional auth and source", async () => {
  const entry = { ...official.apps[0]!, id: "zoho", package: "@executor.sh/zoho", name: "Zoho",
    auth: ["Us", "Eu", "In", "Au", "Jp", "Ca", "Sa", "Cn"].map(region => ({ method: `oauth${region}`, kind: "oauth2" })) };
  for (const zoho of [false, true]) {
    const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"),
      async () => Response.json({ version: 1, apps: [entry] }), { google: !zoho, github: !zoho, zoho });
    const result = (await response.json() as Feed).apps[0]!;
    assert.deepEqual(result.auth, entry.auth);
    assert.equal(result.connectionNotices!.some(notice => notice.message.includes("not set up yet")), !zoho);
    assert.match(result.connectionNotices![0]!.message, /own Zoho CRM account/);
    assert.match(result.connectionNotices![0]!.message, /including writes/);
    assert.match(result.connectionNotices![0]!.message, /data center/);
  }
  const source = '{"package":"@executor.sh/zoho","files":[]}';
  assert.equal(await (await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/zoho.json"),
    async () => new Response(source))).text(), source);
});
