import assert from "node:assert/strict";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { localSlackPackage, readSlackPackage, slackUserMethod } from "./slack-tests/catalog.mjs";

test("the Slack fixture keeps OpenAPI credential origins bare and OAuth endpoint paths intact", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const source = await readSlackPackage(root);
  const origin = "http://127.0.0.1:43210";
  const localized = localSlackPackage(source, origin, `${origin}/catalog/specs/slack-openapi.json`).source;
  const openapi = localized.files.find(file => file.path === "openapi.ts")!.content;
  const allowedOrigin = /allowedOrigin\s*:\s*["']([^"']+)["']/.exec(openapi)?.[1];
  assert.equal(allowedOrigin, origin);
  assert.equal(allowedOrigin, new URL(allowedOrigin!).origin);
  const method = slackUserMethod(localized);
  assert.equal(method.authorizationUrl, `${origin}/oauth/v2/authorize`);
  assert.equal(method.tokenUrl, `${origin}/api/oauth.v2.access`);
});
