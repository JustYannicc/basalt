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
  const entry = (key: string) => `{"key":"${key}","value":{"_tag":"Success"}}`;
  for (const view of ["available", "managed"])
    assert.equal(
      carriesAppsList(
        `<script>${entry(`AtomHttpApi:resourceAccess:directory:{"query":{"view":"${view}"}}`)}</script>`,
      ),
      true,
      view,
    );
  // Every dashboard document carries the shell's reads; they are not the list.
  assert.equal(
    carriesAppsList(
      `<script>${entry("AtomHttpApi:organization:access:{}")}${entry("AtomHttpApi:groups:list:{}")}</script>`,
    ),
    false,
  );
  assert.equal(carriesAppsList("<main>Apps</main>"), false);
});
