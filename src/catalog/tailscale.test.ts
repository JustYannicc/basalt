import assert from "node:assert/strict";
import { test } from "node:test";
import { methodLabels } from "../../.upstream/packages/ui/src/implementation/dashboard/method-labels.ts";
import { handleCatalog } from "./worker.ts";

const entry = (id: string, name: string, auth: unknown[]) => ({
  id,
  package: `@executor.sh/${id}`,
  name,
  description: "Fixture service.",
  auth,
  icons: [],
  source: `apps/${id}.json`,
});

interface ServedEntry {
  id: string;
  connectionGuidance?: {
    requirement: string;
    method: string;
    methodLabel?: string;
    oauthClient: { link: { url: string }; steps: string[] };
  }[];
  oauthDeferrals?: { method: string; message: string }[];
}

const served = async () => {
  const response = await handleCatalog(
    new Request("https://catalog.example.test/catalog/index.json"),
    async () =>
      Response.json({
        version: 1,
        apps: [
          entry("tailscale", "Tailscale", [
            { method: "apiKey", kind: "secrets", label: "API access token" },
            { method: "oauth", kind: "oauth2" },
          ]),
          entry("21risk", "21RISK", [{ method: "oauth", kind: "oauth2" }]),
        ],
      }),
  );
  const feed = (await response.json()) as { apps: ServedEntry[] };
  return (id: string) => feed.apps.find((app) => app.id === id)!;
};

test("Tailscale's OAuth client is named, explained and linked to where its values are created", async () => {
  const tailscale = (await served())("tailscale");
  const guide = tailscale.connectionGuidance?.[0];
  assert.ok(guide);
  assert.equal(guide.requirement, "tailscale");
  assert.equal(guide.method, "oauth");
  assert.equal(guide.methodLabel, "OAuth client");
  assert.deepEqual(tailscale.oauthDeferrals, [
    {
      method: "oauth",
      message:
        "Tailscale has no sign-in for outside apps, so you connect with an OAuth client created in your own tailnet.",
    },
  ]);
  const link = new URL(guide.oauthClient.link.url);
  assert.equal(link.host, "console.tailscale.com");
  assert.equal(link.pathname, "/admin/settings/trust-credentials");
  assert.ok(
    guide.oauthClient.steps.some(
      (step) =>
        step.includes("all scope with Write") &&
        step.includes("full read and write access") &&
        step.includes("Narrower scopes work for narrower use"),
    ),
  );
  assert.ok(guide.oauthClient.steps.some((step) => step.includes("client ID and secret")));

  const methods = [
    ["oauth", { type: "oauth2" }],
    ["apiKey", { type: "secrets", label: "API access token" }],
  ] as const;
  const named = (method: string) =>
    tailscale.connectionGuidance?.find((entry) => entry.method === method)?.methodLabel;
  assert.deepEqual(
    [...methodLabels("Tailscale", methods, named)],
    [
      ["oauth", "OAuth client"],
      ["apiKey", "API access token"],
    ],
  );
  assert.equal(methodLabels("Tailscale", methods).get("oauth"), "Sign in with Tailscale");
});

test("a service still waiting on a sign-in app keeps the generic sentence and method name", async () => {
  const risk = (await served())("21risk");
  assert.equal(risk.connectionGuidance, undefined);
  assert.deepEqual(risk.oauthDeferrals, [
    {
      method: "oauth",
      message:
        "Signalbox has not verified one-click sign-in for 21RISK yet. You can connect with your own OAuth app.",
    },
  ]);
  assert.equal(
    methodLabels("21RISK", [["oauth", { type: "oauth2" }]], () => undefined).get("oauth"),
    "Sign in with 21RISK",
  );
});
