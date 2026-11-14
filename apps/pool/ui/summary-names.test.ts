import assert from "node:assert/strict";
import { test } from "node:test";
import { summaryLabName } from "./summary-names.ts";

const providers = [{ id: "codex", name: "Authoritative lab name", site: "example.test" }];

test("summary lab names stay neutral until their authoritative name is available", () => {
  assert.equal(summaryLabName([], "codex"), "…");
  assert.equal(summaryLabName([], "claude"), "…");
  assert.equal(summaryLabName(providers, "not-in-the-view"), "…");
});

test("summary lab names use the pool view's exact name", () => {
  assert.equal(summaryLabName(providers, "codex"), "Authoritative lab name");
});

test("unattributed summary usage remains an unknown lab", () => {
  assert.equal(summaryLabName(providers, null), "Unknown lab");
});
