import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { providerAppLabs, providerAppSource } from "../../scripts/provider-app-source.ts";
import { providerApps } from "./provider-apps/index.ts";
import { handleCatalog } from "./worker.ts";
import type { Feed } from "./feed.ts";
import { AppIcons } from "apps/contracts";
import { Effect, Exit, Schema } from "effect";
import { CatalogConnectionGuidance } from "../../.upstream/packages/catalog/src/contracts/connection-guidance.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

test("Supported providers publish installable sources with the canonical saved-account identity", async () => {
  const origin = "https://catalog.example.test";
  const feed = (await (
    await handleCatalog(new Request(`${origin}/catalog/index.json`), async () =>
      Response.json({ version: 1, apps: [] }),
    )
  ).json()) as Feed;
  for (const lab of providerAppLabs) {
    const entry = feed.apps.find((entry) => entry.id === `provider-${lab}`);
    assert.ok(entry, `${lab} is missing from Add app`);
    assert.match(entry.description, /pools/);
    assert.ok(entry.icons.length > 0);
    assert.equal(
      Schema.is(AppIcons)(entry.icons),
      true,
      `${lab} icons must satisfy the public app declaration contract`,
    );
    const response = await handleCatalog(
      new Request(`${origin}/catalog/${entry.source}`),
      async () => {
        throw new Error("Provider app sources must not come from another publisher");
      },
    );
    assert.equal(response.status, 200);
    const source = await response.json();
    assert.deepEqual(source, providerAppSource(root, lab));
    assert.equal(source.package, entry.package);
    const declaration = source.files.find((file: { path: string }) => file.path === "providers.ts");
    assert.ok(declaration, `${lab} is missing its provider declaration`);
    assert.equal(
      declaration.content,
      readFileSync(`${root}src/pool/provider-accounts/definitions.ts`, "utf8"),
    );
  }
  assert.equal(providerApps.length, providerAppLabs.length);
});

test("every provider app's connection guidance decodes with the host's catalog schema", () => {
  // The host refuses the whole feed when one entry's guidance is malformed, not just that entry.
  const decode = Schema.decodeUnknownEffect(Schema.Array(CatalogConnectionGuidance));
  for (const app of providerApps)
    if (app.entry.connectionGuidance !== undefined)
      assert.ok(
        Exit.isSuccess(Effect.runSyncExit(decode(app.entry.connectionGuidance))),
        app.entry.id,
      );
  assert.ok(
    providerApps.some((app) => app.entry.id === "provider-custom" && app.entry.connectionGuidance),
  );
  // Help binds by exact requirement and method name, so a misspelling silently drops it from the form.
  for (const app of providerApps) {
    const guidance = (app.entry.connectionGuidance ?? []) as {
      requirement: string;
      method: string;
    }[];
    const methods = (app.entry.auth as { method: string }[]).map((auth) => auth.method);
    for (const entry of guidance) {
      assert.equal(`provider-${entry.requirement}`, app.entry.id, app.entry.id);
      assert.ok(methods.includes(entry.method), `${app.entry.id} ${entry.method}`);
    }
  }
});
