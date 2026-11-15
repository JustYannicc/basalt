// The device approval page, rendered for real: what a device reports about itself shows as its
// claim, escaped and capped, and approving a device for a vault asks to name that vault's app.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadHostedPages } from "./render-tests/hosted-render.mjs";

const origin = "https://cloud.fixture.invalid";
let hosted;
let ui;
before(async () => {
  hosted = await loadHostedPages(['export { DevicePage } from "./device.tsx";'], {
    "contracts/mcp.ts": `import { Atom, AsyncResult } from "effect/reactivity";
import { Effect } from "effect";
import { fixtureAtom } from "fixture-atoms";
export class McpConnectionFailed extends Error {}
export const deviceRequestAtom = () => fixtureAtom("request");
export const mcpClientAtom = () => fixtureAtom("client");
export const deviceDecisionAtom = Atom.fn(() => Effect.succeed({ status: "approved" }));`,
    "contracts/organization.ts": `import { Atom } from "effect/reactivity";
export const organizationsAtom = Atom.readable(() =>
  globalThis.hostedFixture.read("organizations"),
);`,
    "contracts/product-analytics.ts": `export const reportBrowserUsage = () => undefined;`,
    "implementation/resource-origin.ts": `export const useResourceOrigins = () => ({
  mcp: [${JSON.stringify(origin)}],
  api: [${JSON.stringify(origin)}],
});`,
    "contracts/obsidian-vault-name.ts": `import { Atom } from "effect/reactivity";
import { Effect } from "effect";
export const nameVaultAfterDeviceAtom = Atom.fn((input) =>
  Effect.sync(() => globalThis.vaultNamed.push(input)),
);`,
  });
  ({ ui } = hosted);
});
after(() => hosted?.cleanup(), { timeout: 10_000 });

const scoped = `${origin}/mcp?connection=fixture-device&elicitation_mode=native`;
const text = (node) => node?.textContent?.replace(/\s+/g, " ").trim();

/** Mount the page for a code, optionally approve, and read the device's reported labels. */
const review = (request, approve = false) => {
  globalThis.vaultNamed = [];
  const success = (value) => ui.AsyncResult.success(value);
  return hosted.render(
    {
      request: success(request),
      client: success({ client_id: "public-device", client_name: "Alex MacBook Pro" }),
      organizations: success([{ id: "org_fixture", name: "Northwind", slug: "northwind" }]),
    },
    (ui) => ui.createElement(ui.DevicePage, { user_code: "BCDF-GHJK" }),
    async (container) => {
      const reported = [...container.querySelectorAll("span")].find(
        (span) => text(span) === "Reported by the device",
      );
      const claim = reported?.nextElementSibling;
      if (approve) {
        const connect = [...container.querySelectorAll("button")].find(
          (button) => text(button) === "Connect",
        );
        await ui.act(async () => connect.click());
        await ui.act(async () => {});
      }
      return {
        claim: text(claim),
        markup: claim?.querySelector("b") !== null && claim !== undefined,
        named: globalThis.vaultNamed,
        connected: container.textContent.includes("Your device is connected."),
      };
    },
  );
};

test("an older device that reports nothing is reviewed and approved exactly as before", async () => {
  const result = await review(
    { clientId: "public-device", resource: scoped, scopes: ["mcp"] },
    true,
  );
  assert.equal(result.claim, undefined);
  assert.equal(result.connected, true);
  assert.deepEqual(result.named, []);
});

test("a device's labels show as its own claim, as text, and name the vault after approval", async () => {
  const result = await review(
    {
      clientId: "public-device",
      resource: scoped,
      scopes: ["mcp"],
      reported: { name: "<b>Alex MacBook Pro</b>", context: "Personal" },
    },
    true,
  );
  assert.equal(
    result.claim,
    "<b>Alex MacBook Pro</b> · Personal. The device says this about itself; connect only if it matches.",
  );
  assert.equal(result.markup, false);
  assert.equal(result.connected, true);
  assert.deepEqual(result.named, [
    { connection: "fixture-device", vault: "Personal", organizations: ["org_fixture"] },
  ]);
});
