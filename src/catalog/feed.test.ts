import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { mergeFeed, type Feed } from "./feed.ts";
import { handleCatalog } from "./worker.ts";
import { gitlabSource } from "./gitlab.ts";
import sourceSnapshot from "./zendesk/source.json" with { type: "json" };
import sourceProvenance from "./zendesk/provenance.json" with { type: "json" };
import { zendeskAddition } from "./zendesk/source.ts";
import { zendeskIcons } from "./zendesk/logo.ts";

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

test("our connectors list like every other app, with no notice beside their description", async () => {
  const feed: Feed = { version: 1, apps: [
    "google", "gmail", "google-calendar", "google-drive", "google-docs", "google-sheets", "google-slides",
    "github", "gitlab", "miro", "zoho", "elevenlabs", "slack",
  ].map(id => ({ ...official.apps[0]!, id, name: id, package: `@executor.sh/${id}`, auth: [{ method: "oauth", kind: "oauth2" }] })) };
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => Response.json(feed));
  const result = await response.json() as Feed;
  for (const entry of result.apps) {
    assert.equal(entry.connectionNotices, undefined, entry.id);
    const source = feed.apps.find(app => app.id === entry.id);
    if (entry.id === "gitlab") assert.deepEqual(entry.auth, [
      { method: "oauth", kind: "oauth2", label: "OAuth 2.0" },
      { method: "token", kind: "secrets", label: "Personal access token" },
    ]);
    else if (source && entry.id !== "slack" && entry.id !== "miro") assert.deepEqual(entry.auth, source.auth);
  }
});

test("notices from the official feed are dropped", () => {
  const feed = mergeFeed({ version: 1, apps: [{ ...official.apps[0]!,
    connectionNotices: [{ providerName: "Gmail", message: "A long notice." }] }] });
  assert.equal(feed.apps[0]!.connectionNotices, undefined);
});

test("GitLab serves the site-aware source while Miro serves its full REST source", async () => {
  const apps: Feed = { version: 1, apps: ["gitlab", "miro"].map(id => ({ ...official.apps[0]!, id,
    package: `@executor.sh/${id}`, auth: [{ method: "token", kind: "secrets" }, { method: "oauth", kind: "oauth2" }] })) };
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => Response.json(apps));
  const feed = await response.json() as Feed;
  for (const expected of apps.apps) {
    const entry = feed.apps.find(item => item.id === expected.id)!;
    assert.ok(entry);
    if (entry.id === "miro")
      assert.deepEqual((entry.auth as { method: string }[]).map(method => method.method), ["oauth", "token"]);
    else {
      assert.deepEqual((entry.auth as { method: string }[]).map(method => method.method), ["oauth", "token"]);
      assert.match(entry.description, /GitLab\.com or a self-managed instance/);
    }
    assert.equal(entry.source, `apps/${entry.id}.json`);
    const document = JSON.stringify({ package: entry.package, files: [{ path: "index.ts", content: "official package bytes" }] });
    const source = await handleCatalog(new Request(`https://app.signalbox.run/catalog/${entry.source}`), async input => {
      assert.equal(String(input), `https://catalog.executor.sh/${entry.source}`);
      return new Response(document);
    });
    if (entry.id === "miro") {
      const carried = await source.json() as { package: string; files: { path: string }[] };
      assert.equal(carried.package, "@executor.sh/miro");
      assert.ok(carried.files.some(file => file.path === "openapi.ts"));
    } else {
      assert.deepEqual(await source.json(), gitlabSource);
      assert.ok(gitlabSource.files.find(file => file.path === "index.ts")?.content.includes("account.site"));
    }
  }
});

test("ElevenLabs uses its official personal API-key app", async () => {
  const entry = { ...official.apps[0]!, id: "elevenlabs", package: "@executor.sh/elevenlabs", name: "ElevenLabs",
    auth: [{ method: "apiKey", kind: "secrets", label: "API key" }] };
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"), async () => Response.json({ version: 1, apps: [entry] }));
  const result = (await response.json() as Feed).apps[0]!;
  assert.deepEqual(result.auth, entry.auth);
  assert.equal(result.source, "apps/elevenlabs.json");
  const source = '{"package":"@executor.sh/elevenlabs","files":[]}';
  assert.equal(await (await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/elevenlabs.json"), async () => new Response(source))).text(), source);
});

test("Zendesk source snapshot matches its provenance digests", () => {
  const snapshotBytes = readFileSync(new URL("./zendesk/source.json", import.meta.url));
  assert.equal(
    createHash("sha256").update(snapshotBytes).digest("hex"),
    sourceProvenance.snapshotSha256,
  );
  assert.equal(sourceSnapshot.package, "zendesk");
  assert.equal(sourceProvenance.package, sourceSnapshot.package);
  const catalogHashes = sourceProvenance.catalogFileSha256 as Record<string, string>;
  for (const file of sourceSnapshot.files) {
    assert.equal(
      createHash("sha256").update(file.content).digest("hex"),
      catalogHashes[file.path],
      file.path,
    );
  }
  assert.equal(sourceProvenance.siteConfiguration.kind, "native-account-origin");
  assert.equal(sourceProvenance.siteConfiguration.subdomainOf, "zendesk.com");
});

test("Zendesk source is served locally and catalog requests cannot choose its tenant", async () => {
  const response = await handleCatalog(
    new Request("https://app.signalbox.run/catalog/index.json?tenant=untrusted-tenant"),
    async input => {
      assert.equal(String(input), "https://catalog.executor.sh/index.json");
      return Response.json(official);
    },
  );
  assert.equal(response.status, 200);
  const entry = ((await response.json()) as Feed).apps.find(app => app.id === "zendesk");
  assert.ok(entry);
  assert.equal(entry.package, "zendesk");
  assert.deepEqual(entry.auth, [{ method: "oauth", kind: "oauth2" }]);
  assert.deepEqual(entry.icons, zendeskIcons);
  assert.match(entry.icons[0]!.src, /^data:image\/png;base64,/);
  assert.equal(entry.connectionNotices, undefined);
  assert.doesNotMatch(JSON.stringify(entry), /untrusted-tenant/);

  for (const tenant of ["unrelated-one", "unrelated-two", "two.labels", "https://attacker.invalid"]) {
    for (const method of ["GET", "HEAD"]) {
      const source = await handleCatalog(
        new Request("https://app.signalbox.run/catalog/apps/zendesk.json?tenant=" + encodeURIComponent(tenant), { method }),
        async () => { throw new Error("Zendesk source is served locally"); },
      );
      assert.equal(source.status, 200);
      assert.equal(source.headers.get("cache-control"), "public, max-age=300");
      if (method === "HEAD") assert.equal(await source.text(), "");
      else assert.deepEqual(await source.json(), sourceSnapshot);
    }
  }
  assert.deepEqual(zendeskAddition().source, sourceSnapshot);
});

test("Zoho CRM keeps the official regional auth and source", async () => {
  const entry = { ...official.apps[0]!, id: "zoho", package: "@executor.sh/zoho", name: "Zoho",
    auth: ["Us", "Eu", "In", "Au", "Jp", "Ca", "Sa", "Cn"].map(region => ({ method: `oauth${region}`, kind: "oauth2" })) };
  const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [entry] }));
  assert.deepEqual((await response.json() as Feed).apps[0]!.auth, entry.auth);
  const source = '{"package":"@executor.sh/zoho","files":[]}';
  assert.equal(await (await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/zoho.json"),
    async () => new Response(source))).text(), source);
});

test("Slack's carried app and feed select personal OAuth while other sources stay upstream", async () => {
  const slack = { ...official.apps[0]!, id: "slack", package: "@executor.sh/slack", name: "Slack",
    auth: [{ method: "token", kind: "secrets" }, { method: "oauth", kind: "oauth2" }] };
  const index = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [slack] }));
  const entry = (await index.json()).apps[0];
  assert.equal(entry.id, slack.id);
  assert.equal(entry.package, slack.package);
  assert.equal(entry.auth[0].kind, "oauth2");
  assert.equal(entry.auth[0].method, "user");
  assert.ok(!entry.auth.some((method: { method: string }) => method.method === "oauth"), "The bot install is not offered");
  assert.equal(entry.connectionNotices, undefined);
  const noFetch: typeof fetch = async () => { throw new Error("Slack carry must not fetch a moving package"); };
  const source = await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/slack.json"), noFetch);
  assert.equal(source.status, 200);
  const packageSource = await source.json();
  assert.equal(packageSource.package, slack.package);
  assert.ok(packageSource.files.some((file: { path: string }) => file.path === "index.ts"));
  const head = await handleCatalog(new Request("https://app.signalbox.run/catalog/apps/slack.json", { method: "HEAD" }), noFetch);
  assert.equal(await head.text(), "");
  const changedPublisher = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"),
    async () => Response.json({ version: 1, apps: [{ ...slack, package: "@example/replaced" }] }));
  assert.equal(changedPublisher.status, 502);
});
