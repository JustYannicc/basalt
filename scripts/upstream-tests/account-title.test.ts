import assert from "node:assert/strict";
import { test } from "node:test";

type Account = {
  identity?: { label: string };
  label: string;
  providerName?: string;
  health?: { info?: { email?: string; displayName?: string; username?: string } };
};

const contracts = new URL("../../.upstream/packages/ui/src/contracts/", import.meta.url);
const { accountTitle, accountMenuName } = (await import(
  new URL("account-title.ts", contracts).href
)) as {
  accountTitle: (account: Account, fallback?: string, kind?: string) => string;
  accountMenuName: (account: Account, kind?: string, options?: { binding?: boolean }) => string;
};

const reported = { info: { email: "person@example.test" } };

test("a generated label never titles a row when the account's check reported an email", () => {
  assert.equal(accountTitle({ label: "Default", health: reported }), "person@example.test");
  assert.equal(accountTitle({ label: "Default 2", health: reported }), "person@example.test");
  assert.equal(accountTitle({ label: "  ", health: reported }), "person@example.test");
});

test("a verified identity and an authored name keep their precedence", () => {
  const verified = { identity: { label: "verified@example.test" }, health: reported };
  assert.equal(accountTitle({ ...verified, label: "Default" }), "verified@example.test");
  assert.equal(accountTitle({ ...verified, label: "Work" }), "verified@example.test");
  assert.equal(accountTitle({ label: "Work", health: reported }), "Work");
  // Only the exact generated pattern counts as generated.
  assert.equal(accountTitle({ label: "Default account", health: reported }), "Default account");
});

test("without a reported value a generated label reads as the provider and kind, never Default", () => {
  const key = { providerName: "ElevenLabs" };
  assert.equal(
    accountTitle({ ...key, label: "Default" }, undefined, "API key"),
    "ElevenLabs API key",
  );
  assert.equal(
    accountTitle({ ...key, label: "Default 2" }, undefined, "API key"),
    "ElevenLabs API key 2",
  );
  assert.equal(
    accountTitle({ providerName: "Jev", label: "Default", health: {} }, undefined, "API key"),
    "Jev API key",
  );
  // An unknown kind still names the provider.
  assert.equal(accountTitle({ ...key, label: "Default 3" }), "ElevenLabs account 3");
  // No provider name: the fallback, keeping the generated number distinct.
  assert.equal(accountTitle({ label: "Default" }), "Unnamed account");
  assert.equal(accountTitle({ label: "Default 3", health: {} }), "Unnamed account 3");
  assert.equal(accountTitle({ label: "Default" }, "Codex"), "Codex");
  assert.equal(accountTitle({ label: "" }, "Codex"), "Codex");
  assert.equal(accountTitle({ label: "" }), "Unnamed account");
  // A reported value and an authored name still come first.
  assert.equal(
    accountTitle({ ...key, label: "Default", health: reported }, undefined, "API key"),
    "person@example.test",
  );
  assert.equal(accountTitle({ ...key, label: "Studio" }, undefined, "API key"), "Studio");
  assert.equal(
    accountTitle({ label: "Default", health: { info: { username: "octocat" } } }),
    "octocat",
  );
});

test("edge cases keep the provider-and-kind title honest", () => {
  // A blank label is as unnamed as a generated one.
  assert.equal(
    accountTitle({ providerName: "Acme", label: "" }, undefined, "API key"),
    "Acme API key",
  );
  // Padding around a generated label keeps its number.
  assert.equal(
    accountTitle({ providerName: "Acme", label: " Default 2 " }, undefined, "API key"),
    "Acme API key 2",
  );
  // A combined kind names the row by its first part.
  assert.equal(
    accountTitle({ providerName: "Acme", label: "Default 2" }, undefined, "API key · Metered API"),
    "Acme API key 2",
  );
  // A blank kind reads as an account; a blank provider name falls back, keeping the number.
  assert.equal(
    accountTitle({ providerName: "Acme", label: "Default" }, undefined, "  "),
    "Acme account",
  );
  assert.equal(
    accountTitle({ providerName: "  ", label: "Default 2" }, undefined, "API key"),
    "Unnamed account 2",
  );
  // The app tab's provider-name fallback keeps the number too.
  assert.equal(accountTitle({ label: "Default 2" }, "Codex"), "Codex 2");
});

test("an account's own menu is named by its given name, else its row title, never Default", () => {
  const key = { providerName: "Jev", label: "Default" };
  assert.equal(accountMenuName(key, "API key"), "Jev API key");
  assert.equal(accountMenuName({ ...key, label: "Default 2" }, "API key"), "Jev API key 2");
  assert.equal(accountMenuName({ ...key, health: reported }, "API key"), "person@example.test");
  // A name the person gave stays exactly, even under a verified identity.
  assert.equal(
    accountMenuName({
      ...key,
      label: "First saved sign-in",
      identity: { label: "group@example.test" },
    }),
    "First saved sign-in",
  );
  // A row outside a group is named by its title, a verified identity included.
  assert.equal(
    accountMenuName({ ...key, identity: { label: "group@example.test" } }, "API key"),
    "group@example.test",
  );
  // Grouped sign-ins are named only by what is their own, so siblings stay distinct even when
  // their checks report the group's email.
  const sibling = { ...key, identity: { label: "group@example.test" }, health: reported };
  assert.equal(accountMenuName(sibling, "API key", { binding: true }), "Jev API key");
  assert.equal(
    accountMenuName({ ...sibling, label: "Default 2" }, "API key", { binding: true }),
    "Jev API key 2",
  );
  assert.equal(
    accountMenuName({ ...sibling, label: "First saved sign-in" }, "API key", { binding: true }),
    "First saved sign-in",
  );
});

test("requirement titles preserve the row provider name and fallback while sharing the SDK rule", async () => {
  const { requirementAccountTitle } = (await import(
    new URL("account-identities.ts", contracts).href
  )) as typeof import("../../.upstream/packages/ui/src/contracts/account-identities.ts");
  const account = {
    label: "Default 2",
    provider: "prv_example",
    method: "key",
    providerName: "Row provider",
  } as unknown as Parameters<typeof requirementAccountTitle>[0];
  const requirement = {
    provider: account.provider,
    definition: { name: "Declared provider", auth: { key: { type: "secrets", label: "Key" } } },
  } as unknown as Parameters<typeof requirementAccountTitle>[1][number];
  assert.equal(requirementAccountTitle(account, [requirement]), "Row provider account 2");
  assert.equal(requirementAccountTitle(account, []), "Row provider account 2");
  assert.equal(
    requirementAccountTitle({ ...account, providerName: undefined }, [], "Fallback"),
    "Fallback 2",
  );
});
