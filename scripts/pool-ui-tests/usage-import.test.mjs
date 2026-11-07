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
  assert.ok(
    isAbsolute(artifacts) && !artifacts.startsWith(root),
    "Keep PR evidence outside the checkout",
  );
  mkdirSync(artifacts, { recursive: true });
}

function metadataFile(start, length = 401) {
  return {
    name: "prepared-usage.jsonl",
    mimeType: "application/jsonl",
    buffer: Buffer.from(
      Array.from({ length }, (_, i) =>
        JSON.stringify({
          event_hash: (start + i).toString(16).padStart(64, "0"),
          timestamp: "2026-05-05T11:32:18.619000001Z",
          failed: false,
          provider: "fixture-provider",
          model: "fixture-model",
          input_tokens: "100",
          output_tokens: "10",
          total_tokens: "110",
          raw_json: "private-message-sentinel",
        }),
      ).join("\n"),
    ),
  };
}

async function query(connectionString, text) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    return await client.query(text);
  } finally {
    await client.end();
  }
}

test(
  "usage import previews, pauses, resumes and deduplicates through the app and signed HTTP service",
  { skip: !available, timeout: 120_000 },
  async (t) => {
    const schema = `import_ui_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({ connectionString: admin });
    await db.connect();
    await historySchemaFixture(db, schema);
    await db.query(`SET search_path TO ${schema}`);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    await db.end();
    const url = new URL(admin);
    url.searchParams.set("options", `-c search_path=${schema}`);
    let fixture, browserServer, browser;
    t.after(async () => {
      await browser?.close();
      await browserServer?.close();
      await fixture?.close();
      await query(admin, `DROP SCHEMA ${schema} CASCADE`);
    });
    fixture = await importAppFixture(url.href);
    const initialView = await fetch(`${fixture.origin}/_executor/api/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "view", input: {} }),
    });
    assert.equal(initialView.status, 200, await initialView.clone().text());
    assert.equal(
      (await initialView.json()).value.isOwner,
      false,
      "a current manager need not be the original owner",
    );
    browserServer = await chromium.launchServer({ headless: true });
    assert.ok(browserServer.process().pid);
    browser = await chromium.connect(browserServer.wsEndpoint());
    const count = async () =>
      Number((await query(url.href, "SELECT count(*) AS n FROM basalt_model_requests")).rows[0].n);
    let retained = 0;
    for (const width of [1280, 390]) {
      await t.test(`${width}px import flow`, async () => {
        const context = await browser.newContext({ viewport: { width, height: 1000 } });
        const errors = [],
          requests = [];
        try {
          const page = await context.newPage();
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("request", (request) => requests.push(request.url()));
          await context.route("**/*", (route) =>
            route.request().url().startsWith(fixture.origin) ? route.continue() : route.abort(),
          );
          await page.goto(fixture.origin);
          await page.getByRole("button", { name: "Import usage", exact: true }).click();
          if (artifacts)
            await page.screenshot({ path: join(artifacts, `choose-${width}.png`), fullPage: true });
          const file = metadataFile(width * 10_000);
          await page.getByLabel("Choose a usage export", { exact: true }).setInputFiles(file);
          await page.getByRole("button", { name: "Import usage", exact: true }).waitFor();
          assert.equal(await count(), retained, "preview must not write history");
          await page.getByText("401", { exact: true }).waitFor();
          assert.doesNotMatch(JSON.stringify(fixture.calls), /private-message-sentinel/);
          if (artifacts)
            await page.screenshot({ path: join(artifacts, `review-${width}.png`), fullPage: true });

          const held = fixture.holdApply();
          await page.getByRole("button", { name: "Import usage", exact: true }).click();
          await held.started;
          await page.getByRole("button", { name: "Pause import", exact: true }).click();
          await page.getByRole("button", { name: "Back to pool", exact: true }).click();
          held.release();
          await page.getByRole("button", { name: "View import", exact: true }).click();
          await page.getByRole("button", { name: "Resume import", exact: true }).waitFor();
          assert.equal(await count(), retained + 200);
          if (artifacts)
            await page.screenshot({ path: join(artifacts, `paused-${width}.png`), fullPage: true });
          await page.getByRole("button", { name: "Resume import", exact: true }).click();
          await page.getByRole("heading", { name: "Usage imported", exact: true }).waitFor();
          retained += 401;
          assert.equal(await count(), retained);
          const leaked = (
            await query(
              url.href,
              "SELECT count(*) AS n FROM basalt_model_requests WHERE person IS NOT NULL OR cost IS NOT NULL OR cost_basis <> 'unpriced'",
            )
          ).rows[0].n;
          assert.equal(Number(leaked), 0);
          const dimensions = await page.evaluate(() => ({
            width: innerWidth,
            scroll: document.documentElement.scrollWidth,
          }));
          assert.ok(dimensions.scroll <= dimensions.width, JSON.stringify(dimensions));
          assert.equal(
            await page.getByRole("link", { name: "View all history" }).getAttribute("href"),
            "#usage-history",
          );
          if (artifacts)
            await page.screenshot({
              path: join(artifacts, `complete-${width}.png`),
              fullPage: true,
            });

          await page.getByRole("button", { name: "Import another export", exact: true }).click();
          await page.getByLabel("Choose a usage export", { exact: true }).setInputFiles(file);
          await page.getByRole("button", { name: "Import usage", exact: true }).click();
          await page.getByRole("heading", { name: "Usage imported", exact: true }).waitFor();
          assert.equal(await count(), retained, "reimport must not duplicate history");
          assert.deepEqual(errors, []);
          assert.ok(
            requests.every(
              (request) => !request.includes("usage-queue") && !request.includes("usage/queue"),
            ),
          );
        } finally {
          await context.close();
        }
      });
    }

    await t.test("a lost apply reply remains retryable without duplicate records", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/#usage-import`);
        await page
          .getByLabel("Choose a usage export", { exact: true })
          .setInputFiles(metadataFile(99_000_000, 1));
        await page.getByRole("button", { name: "Import usage", exact: true }).waitFor();
        fixture.loseApplyReply();
        await page.getByRole("button", { name: "Import usage", exact: true }).click();
        await page.getByRole("button", { name: "Resume import", exact: true }).waitFor();
        assert.equal(await count(), retained + 1);
        await page.getByRole("button", { name: "Resume import", exact: true }).click();
        await page.getByRole("heading", { name: "Usage imported", exact: true }).waitFor();
        assert.equal(await count(), retained + 1);
      } finally {
        await context.close();
      }
    });
    await t.test("a member cannot open or bypass the manager import flow", async () => {
      fixture.member();
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/#usage-import`);
        await page
          .getByText("Only a pool manager can import usage history.", { exact: true })
          .waitFor();
        assert.equal(await page.locator('input[type="file"]').count(), 0);
        const response = await page.request.post(`${fixture.origin}/_executor/api/mutate`, {
          data: {
            version: "fixture",
            name: "importUsage",
            input: {
              format: "cpamp-v1-jsonl",
              mode: "dry-run",
              data: metadataFile(1, 1).buffer.toString(),
            },
          },
        });
        assert.deepEqual(await response.json(), {
          ok: false,
          error: "not_owner",
          message: "Only a pool manager can import usage history.",
        });
      } finally {
        await context.close();
      }
    });
    assert.deepEqual(fixture.unexpected, []);
  },
);
