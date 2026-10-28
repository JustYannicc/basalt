import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = new URL("../../.upstream/packages/ui/src/implementation/dashboard/", import.meta.url);
const { methodLabels } = (await import(new URL("method-labels.ts", dashboard).href)) as {
  methodLabels: (
    provider: string,
    methods: ReadonlyArray<readonly [string, { type: string; label?: string }]>,
  ) => ReadonlyMap<string, string>;
};

const labels = (provider: string, methods: [string, { type: string; label?: string }][]) =>
  [...methodLabels(provider, methods).values()];
const oauth = { type: "oauth2" };

test("a connect form never shows two sign-in methods with the same label", () => {
  assert.deepEqual(labels("Slack", [["user", oauth], ["token", { type: "secrets", label: "Paste a token" }]]),
    ["Sign in with Slack", "Paste a token"]);
  assert.deepEqual(labels("GitHub", [["oauth", oauth], ["token", { type: "secrets", label: "Personal access token" }]]),
    ["Sign in with GitHub", "Personal access token"]);
  assert.deepEqual(labels("Zoho CRM", ["Us", "Eu", "In", "Cn"].map(region => [`oauth${region}`, oauth])),
    ["Sign in with Zoho CRM (US)", "Sign in with Zoho CRM (EU)", "Sign in with Zoho CRM (IN)", "Sign in with Zoho CRM (CN)"]);
  assert.deepEqual(labels("Datadog", [["us1", oauth], ["eu1", oauth]]),
    ["Sign in with Datadog (US1)", "Sign in with Datadog (EU1)"]);
  assert.deepEqual(labels("Vibe", [["oauth", oauth], ["serverToServer", oauth]]),
    ["Sign in with Vibe (OAuth)", "Sign in with Vibe (Server To Server)"]);
  const password = { type: "secrets", label: "Username and password" };
  assert.deepEqual(labels("Carrier", [["basic", password], ["basicTest", password]]),
    ["Username and password (Basic)", "Username and password (Basic Test)"]);
  const alike = labels("Example", [["oauth", oauth], ["oauth2", oauth]]);
  assert.equal(new Set(alike).size, alike.length);
});

test("the connect form labels methods through the shared rule", () => {
  const form = readFileSync(new URL("account-form.tsx", dashboard), "utf8");
  assert.match(form, /const labels = methodLabels\(provider\.definition\.name, methods\)/);
  assert.match(form, /\{labels\.get\(name\)\}/);
  assert.doesNotMatch(form, /`Sign in with \$\{provider\.definition\.name\}`/);
});
