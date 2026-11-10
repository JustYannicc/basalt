import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);
const rendered: Record<string, string> = JSON.parse(
  execFileSync("bun", ["scripts/upstream-tests/fixtures/oauth-setup-copy.mjs"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
const text = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ");

test("Plaid machine setup shows only its Production-key instructions", () => {
  const copy = text(rendered.plaid!);
  assert.match(copy, /Use your Plaid Production client ID and secret\./);
  assert.match(copy, /does not use browser sign-in\./);
  assert.doesNotMatch(copy, /Create an OAuth client|developer settings|redirect URL/);
});

test("machine setup distinguishes client credentials from the app's access-token destination", () => {
  const copy = text(rendered.plaid!);
  assert.match(copy, /client ID and secret are sent to production\.plaid\.com/);
  assert.match(copy, /access token is only sent to api\.dashboard\.plaid\.com/);
  assert.doesNotMatch(copy, /sign-in is only sent/);
});

test("machine setup keeps generic client instructions when none were supplied", () => {
  assert.match(text(rendered.genericMachine!), /Create an OAuth client/);
  assert.match(text(rendered.genericMachine!), /production\.plaid\.com/);
});

test("discovered machine setup never invents the token endpoint host", () => {
  const copy = text(rendered.discoveredMachine!);
  assert.match(copy, /client ID and secret are sent to the service[’']s token endpoint/);
  assert.doesNotMatch(copy, /identity\.example\.test/);
});

test("browser OAuth keeps its client setup and access notice", () => {
  const copy = text(rendered.browser!);
  assert.match(copy, /Create an OAuth app/);
  assert.match(copy, /sign-in is only sent to api\.dashboard\.plaid\.com/);
  assert.doesNotMatch(copy, /client ID and secret are sent/);
  assert.match(text(rendered.deferredBrowser!), /Create an OAuth app/);
});

test("site-bound machine setup names the selected token destination", () => {
  const copy = text(rendered.siteMachine!);
  assert.match(copy, /client ID and secret are sent to customer\.example\.test/);
  assert.doesNotMatch(copy, /template\.example\.test/);
});
