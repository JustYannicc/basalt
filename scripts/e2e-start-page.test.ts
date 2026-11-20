import assert from "node:assert/strict";
import { test } from "node:test";
import { startPage } from "../.upstream/e2e/support/start-page.ts";

const destination = (path: string) => new URL(path, "http://dashboard.invalid");

test("a scenario starts from Connect unless it names another page", () => {
  assert.equal(startPage(destination("/org/acme/apps")), "/org/acme/connect");
  assert.equal(startPage(destination("/org/acme/apps"), "connect"), "/org/acme/connect");
  assert.equal(
    startPage(destination("/account/tokens?organization=acme")),
    "/org/acme/connect",
    "an account page names its organization in the search parameter",
  );
  assert.equal(startPage(destination("/apps/app-1?view=source")), "/connect");
});

test("a scenario that holds the Apps list starts from the organization's Settings page", () => {
  assert.equal(startPage(destination("/org/acme/apps"), "settings"), "/org/acme/organization");
  assert.equal(
    startPage(destination("/org/acme/groups/group-1"), "settings"),
    "/org/acme/organization",
  );
  assert.equal(
    startPage(destination("/account/tokens?organization=acme"), "settings"),
    "/org/acme/organization",
    "an account page starts in the organization its search parameter names",
  );
  assert.equal(
    startPage(new URL("https://cloud.example/org/acme/apps/app-1?view=settings"), "settings"),
    "/org/acme/organization",
  );
});

test("the local dashboard has no Settings page to start from, so asking for it fails", () => {
  assert.throws(
    () => startPage(destination("/apps/app-1"), "settings"),
    /local dashboard has no settings page/,
  );
});
