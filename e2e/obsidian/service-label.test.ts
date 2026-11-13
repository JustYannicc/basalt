import { test } from "node:test";
import assert from "node:assert/strict";
import { obsidian } from "../../src/catalog/obsidian/index.ts";
import { Schema } from "effect";
import { CatalogEntry } from "../../.upstream/packages/catalog/src/contracts/catalog.ts";
import {
  legacyService,
  serviceLabel,
} from "../../.upstream/apps/hosted/server/src/implementation/service-install-records.ts";

// Read through the catalog's own schema, so the fixture can't drift from what hosts receive.
const decode = Schema.decodeUnknownSync(CatalogEntry);
const entry = decode({ ...obsidian.entry, icons: [] });
const { instanceNoun: _noun, instanceNameHint: _hint, ...listing } = obsidian.entry;
const plain = decode({ ...listing, id: "tracker", package: "tracker", name: "Tracker", icons: [] });

test("a copy records its service's name and, where the catalog gives one, what a copy is called", () => {
  assert.deepEqual(serviceLabel(entry), { name: "Obsidian", noun: "vault" });
  assert.deepEqual(serviceLabel(plain), { name: "Tracker" });
});

test("a copy installed before services were recorded is named by its package's entry", () => {
  assert.deepEqual(legacyService("obsidian", entry), {
    id: "obsidian",
    newInstance: false,
    name: "Obsidian",
    noun: "vault",
  });
  // A package no entry lists keeps its exact identity and no name.
  assert.deepEqual(legacyService("@fixture/unlisted", undefined), {
    id: "@fixture/unlisted",
    newInstance: false,
  });
});
