import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { localSlackPackage, readSlackPackage, slackUserMethod } from "./catalog.mjs";
import { startSlackMock } from "./mock.mjs";

test("the Slack fixture serves a catalog, package and metadata over HTTP", async () => {
  const root = resolve(import.meta.dirname, "../..");
  const source = await readSlackPackage(root);
  const directory = await mkdtemp(join(tmpdir(), "slack-fixture-"));
  let fixture;
  try {
    const method = slackUserMethod(source);
    fixture = await startSlackMock({ directory, source,
      vendorSpec: { swagger: "2.0", host: "slack.com", basePath: "/api", schemes: ["https"] },
      userScope: method.userScope,
      authorizationPath: new URL(method.authorizationUrl).pathname,
      tokenPath: new URL(method.tokenUrl).pathname,
    });
    const localized = localSlackPackage(source, fixture.origin, fixture.openapiSpecUrl).source;
    await fixture.loadFixture(localized);
    const read = async (path, init) => {
      const response = await fetch(`${fixture.origin}${path}`, init);
      assert.equal(response.status, 200);
      return response.json();
    };
    const feed = await read("/catalog/index.json");
    assert.equal(feed.apps.length, 1);
    assert.equal(feed.apps[0].id, "slack");
    assert.equal(feed.apps[0].auth[0].method, "user");
    assert.equal(feed.apps[0].auth[1].label, "Paste a token");
    const served = await read("/catalog/apps/slack.json");
    assert.deepEqual(served, localized);
    const openapi = served.files.find(file => file.path === "openapi.ts").content;
    const allowedOrigin = /allowedOrigin\s*:\s*["']([^"']+)["']/.exec(openapi)?.[1];
    assert.equal(allowedOrigin, fixture.origin);
    const localMethod = slackUserMethod(served);
    assert.equal(localMethod.authorizationUrl, `${fixture.origin}/oauth/v2/authorize`);
    assert.equal(localMethod.tokenUrl, `${fixture.origin}/api/oauth.v2.access`);
    const spec = await read("/catalog/specs/slack-openapi.json");
    assert.equal(spec.host, new URL(fixture.origin).host);
    const info = await read("/api/users.profile.get?user=UOWNER001", {
      headers: { authorization: "Bearer xoxp-synthetic-owner" },
    });
    assert.equal(info.ok, true);
    assert.equal(info.profile.display_name, "Synthetic Owner");
    assert.equal(info.profile.email, "owner@example.test");
    assert.equal(info.profile.image_192, "https://example.test/avatar.png");
  } finally {
    if (fixture) await fixture.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
