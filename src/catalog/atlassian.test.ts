import assert from "node:assert/strict";
import { test } from "node:test";
import { atlassianAddition } from "./atlassian/index.ts";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";

const official: Feed = { version: 1, apps: [] };

test("the feed offers the personal Atlassian app with setup and consent notices", async () => {
  for (const configured of [false, true]) {
    const response = await handleCatalog(new Request("https://app.signalbox.run/catalog/index.json"),
      async () => Response.json(official), { google: false, github: false, atlassian: configured });
    assert.equal(response.status, 200);
    const body = await response.json() as Feed;
    const entry = body.apps.find(app => app.id === "atlassian")!;
    assert.equal(entry.package, "@executor.sh/atlassian");
    assert.equal(entry.source, "apps/atlassian.json");
    assert.deepEqual(entry.auth, [{ method: "oauth", kind: "oauth2" }]);
    const notice = entry.connectionNotices![0]!;
    assert.equal(notice.providerName, "Atlassian");
    assert.equal(notice.message.includes("not set up yet"), !configured);
    assert.match(notice.message, /unreviewed-app warning/);
    assert.match(notice.message, /your own account/);
    assert.doesNotMatch(notice.message, /executor/i);
  }
});

test("the app source is served locally without contacting the official publisher", async () => {
  const noFetch: typeof fetch = async () => { throw new Error("Unexpected publisher call"); };
  const url = "https://app.signalbox.run/catalog/apps/atlassian.json";
  const response = await handleCatalog(new Request(url, {
    headers: { Authorization: "Bearer fixture", Cookie: "session=fixture" },
  }), noFetch);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), atlassianAddition().source);
  const head = await handleCatalog(new Request(url, { method: "HEAD" }), noFetch);
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await handleCatalog(new Request(url, { method: "POST" }), noFetch)).status, 405);
});
