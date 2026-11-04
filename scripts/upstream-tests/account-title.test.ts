import assert from "node:assert/strict";
import { test } from "node:test";

type Account = {
  identity?: { label: string };
  label: string;
  health?: { info?: { email?: string; displayName?: string; username?: string } };
};

const contracts = new URL("../../.upstream/packages/ui/src/contracts/", import.meta.url);
const { accountTitle } = (await import(new URL("account-title.ts", contracts).href)) as {
  accountTitle: (account: Account, fallback?: string) => string;
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

test("without a reported value the generated label stays, never a guess", () => {
  assert.equal(accountTitle({ label: "Default" }), "Default");
  assert.equal(accountTitle({ label: "Default 3", health: {} }), "Default 3");
  assert.equal(accountTitle({ label: "Default" }, "Codex"), "Default");
  assert.equal(accountTitle({ label: "" }, "Codex"), "Codex");
  assert.equal(accountTitle({ label: "" }), "Unnamed account");
  assert.equal(
    accountTitle({ label: "Default", health: { info: { username: "octocat" } } }),
    "octocat",
  );
});
