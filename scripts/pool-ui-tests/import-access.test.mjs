import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { historySchemaFixture, homeMetadataFixture } from "../pool-tests/history-fixture.ts";
import { chromium, importAppFixture, root } from "./import-app-fixture.mjs";

const { default: pg } = await import(createRequire(join(root, "package.json")).resolve("pg"));
const admin = process.env.POOL_TEST_ADMIN_URL;
const available = admin && ["localhost", "127.0.0.1"].includes(new URL(admin).hostname);
const artifacts = process.env.POOL_UI_ARTIFACTS;
if (artifacts) {
  assert.ok(isAbsolute(artifacts) && !artifacts.startsWith(root));
  mkdirSync(artifacts, { recursive: true });
}

async function query(url, sql) {
  const db = new pg.Client({ connectionString: url });
  try {
    await db.connect();
    return await db.query(sql);
  } finally {
    await db.end();
  }
}

test(
  "direct import access reports unavailable revision heads and recovers through the fence",
  {
    skip: !available,
    timeout: 60_000,
  },
  async (t) => {
    const schema = `import_access_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(admin);
    url.searchParams.set("options", `-c search_path=${schema}`);
    let fixture, browser;
    t.after(async () => {
      await browser?.close();
      await fixture?.close();
      await query(admin, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    });
    const db = new pg.Client({ connectionString: admin });
    try {
      await db.connect();
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await homeMetadataFixture(db);
      await migrateModelHistory(db);
    } finally {
      await db.end();
    }
    fixture = await importAppFixture(url.href);
    browser = await chromium.launch({ headless: true });
    let imported = 0;
    for (const status of [404, 503]) {
      for (const width of [1280, 390]) {
        await t.test(`${width}px unavailable ${status} heads and recovery`, async () => {
          const context = await browser.newContext({ viewport: { width, height: 1000 } });
          const overview = [],
            errors = [];
          const priorCalls = fixture.calls.length;
          let unavailable = true;
          try {
            await context.route("**/_executor/api/changes/current", (route) =>
              unavailable
                ? route.fulfill({ status, contentType: "application/json", body: "{}" })
                : route.continue(),
            );
            const page = await context.newPage();
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("request", (request) => {
              if (request.url().endsWith("/_executor/api/pool-usage/overview"))
                overview.push(request.url());
            });
            const refused = page.waitForResponse(
              (response) =>
                response.url().endsWith("/changes/current") && response.status() === status,
            );
            await page.goto(`${fixture.origin}/#usage-import`);
            await refused;
            await page
              .getByText("Pool access could not be checked. Try again.", { exact: true })
              .waitFor({ timeout: 5_000 });
            assert.equal(await page.locator('input[type="file"]').count(), 0);
            assert.equal(
              fixture.calls.length,
              priorCalls,
              "unavailable heads cannot preview or apply an import",
            );
            assert.equal(
              overview.length,
              0,
              "protected overview work waits for an accepted revision baseline",
            );
            if (artifacts)
              await page.screenshot({
                path: join(artifacts, `unavailable-${status}-${width}.png`),
                fullPage: true,
              });
            unavailable = false;
            await page.getByRole("button", { name: "Check again", exact: true }).click();
            await page.getByLabel("Source name", { exact: true }).waitFor();
            assert.ok(overview.length > 0, "a valid head baseline permits the manager check");
            await page.getByLabel("Source name", { exact: true }).fill("Access recovery fixture");
            await page.getByLabel("Choose a usage export", { exact: true }).setInputFiles({
              name: "usage.jsonl",
              mimeType: "application/jsonl",
              buffer: Buffer.from(
                JSON.stringify({
                  event_hash: (++imported).toString(16).padStart(64, "0"),
                  timestamp: "2026-05-05T11:32:18Z",
                  failed: false,
                  model: "fixture-model",
                }),
              ),
            });
            await page.getByRole("button", { name: "Import usage", exact: true }).click();
            await page.getByRole("heading", { name: "Usage imported", exact: true }).waitFor();
            assert.equal(
              Number(
                (await query(url.href, "SELECT count(*) AS n FROM basalt_model_requests")).rows[0]
                  .n,
              ),
              imported,
            );
            assert.deepEqual(errors, []);
            if (artifacts)
              await page.screenshot({
                path: join(artifacts, `recovered-${status}-${width}.png`),
                fullPage: true,
              });
          } finally {
            await context.close();
          }
        });
      }
    }
  },
);
