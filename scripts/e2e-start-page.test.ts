import assert from "node:assert/strict";
import { test } from "node:test";
import { carriesAppsList, startPage } from "../.upstream/e2e/support/start-page.ts";

const destination = (path: string) => new URL(path, "http://dashboard.invalid");

test("the start page is Connect unless another is named", () => {
  assert.equal(startPage(destination("/org/acme/apps")), "/org/acme/connect");
  assert.equal(startPage(destination("/org/acme/apps"), "connect"), "/org/acme/connect");
  assert.equal(
    startPage(destination("/account/tokens?organization=acme")),
    "/org/acme/connect",
    "an account page names its organization in the search parameter",
  );
  assert.equal(startPage(destination("/apps/app-1?view=source")), "/connect");
});

test("the settings start page is in the organization the destination names", () => {
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

test("a destination that names no organization cannot start from settings", () => {
  // The local dashboard has no organizations; a hosted account page may leave its one out.
  for (const path of ["/apps/app-1", "/account/tokens"])
    assert.throws(
      () => startPage(destination(path), "settings"),
      /names no organization to start from its settings page/,
      path,
    );
});

test("only an entry for the Apps list's read counts as a carried list", () => {
  // A read that follows the organization's revisions is sent under `hosted:accepted:` and its
  // query's key, which ends in the request with its properties in order.
  const accepted = (endpoint: string, request: object) =>
    JSON.stringify({
      "~effect/reactivity/Hydration/DehydratedAtom": true,
      key: `hosted:accepted:AtomHttpApi:${endpoint}:${JSON.stringify(request)}`,
      value: { body: { _tag: "Success" }, receipt: { revisions: [] } },
    });
  const list = (view: string) =>
    accepted("resourceAccess:directory", { params: { organization: "acme" }, query: { view } });
  for (const view of ["available", "managed"])
    assert.equal(carriesAppsList(`<script>${list(view)}</script>`), true, view);
  // The organization's inventory is another such read, and every document carries its access.
  const others = [
    accepted("organization:inventory", { params: { organization: "acme" } }),
    JSON.stringify({ key: "hosted:organization-access:acme", value: { _tag: "Success" } }),
  ];
  assert.equal(carriesAppsList(`<script>${others.join("")}</script>`), false);
  assert.equal(carriesAppsList("<main>Apps</main>"), false);
});
