import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { historyFixture } from "./history-fixture.mjs";

test(
  "history reports retained request coverage, and a later checked watermark cannot advance it",
  { timeout: 60_000 },
  async (t) => {
    const fixture = await historyFixture({ diagnostic: (message) => t.diagnostic(message) });
    t.after(() => fixture.close());
    for (const width of [1280, 390]) {
      await t.test(`${width}px coverage and continued capture`, async () => {
        const { page, context, errors } = await fixture.page(width);
        try {
          const coverage = page.getByText(/^Last retained request/);
          assert.equal(
            await coverage.count(),
            1,
            "Coverage names the last request, not the ingestion watermark",
          );
          assert.match(await coverage.innerText(), /Nov 4, 2026/);
          assert.doesNotMatch(await coverage.innerText(), /Nov 9/);
          assert.equal(
            await coverage.locator("time").getAttribute("datetime"),
            "2026-11-04T11:28:37.250Z",
          );
          assert.equal(
            await page.getByRole("radio", { name: "All retained", exact: true }).count(),
            1,
          );
          assert.match(await page.locator("body").innerText(), /All retained/);
          assert.doesNotMatch(await page.locator("body").innerText(), /Captured through/);
          await page.evaluate(() => window.addSyntheticRequest());
          await page.getByRole("button", { name: "Reload", exact: true }).click();
          await page.locator('time[datetime="2026-11-09T08:01:02.000Z"]').waitFor();
          assert.match(await coverage.innerText(), /Nov 9, 2026/);
          assert.match(
            await page.getByRole("region", { name: "History totals" }).innerText(),
            /2 retained records/,
          );
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      });
    }
  },
);

for (const pageSize of [10, 25])
  for (const width of [1280, 390])
    test(
      `filtered History keeps page 2 across usage revisions with ${pageSize}-row source pages at ${width}px`,
      { timeout: 60_000 },
      async (t) => {
        const fixture = await historyFixture({
          initialRequests: 25,
          pageSize,
          diagnostic: (message) => t.diagnostic(message),
        });
        t.after(() => fixture.close());
        const { page, context, errors } = await fixture.page(width, { search: "?lab=codex" });
        t.after(() => context.close());
        const artifacts = process.env.HISTORY_UI_ARTIFACTS;
        const label = `filtered-${pageSize}-${width}`;
        const capture = async (name) => {
          if (!artifacts) return;
          mkdirSync(artifacts, { recursive: true });
          await page.locator("body").screenshot({ path: join(artifacts, `${label}-${name}.png`) });
          writeFileSync(join(artifacts, `${label}-${name}.html`), await page.content());
        };
        try {
          await page.getByRole("button", { name: "Next", exact: true }).click();
          await page.getByText("Page 2", { exact: true }).waitFor();
          const rows = page.getByRole("region", { name: "Request history", exact: true });
          const before = await rows.innerText();
          assert.equal(await rows.locator("tbody tr").count(), 10);
          assert.equal(
            fixture.requests.some(({ input }) => input.after !== undefined),
            pageSize === 10,
          );
          await capture("before");
          const start = fixture.requests.length;
          fixture.hold("series");
          fixture.change();
          await fixture.waitFor(
            () => fixture.requests.slice(start).some(({ kind }) => kind === "series"),
            { name: `filtered ${pageSize}-row ${width}px refresh series` },
          );
          await page.getByText("Updating…", { exact: true }).waitFor();
          fixture.release();
          await page.getByText("Updating…", { exact: true }).waitFor({ state: "hidden" });
          await capture("after");
          assert.equal(await page.getByText("Page 2", { exact: true }).count(), 1);
          assert.equal(
            await rows.count(),
            1,
            "A usage hint cannot discard the filtered page's records",
          );
          assert.equal(await rows.innerText(), before);
          const newer = page.getByText("Newer usage arrived. Reload to include it.", {
            exact: true,
          });
          assert.equal(await newer.count(), 1);
          await page.getByRole("button", { name: "Reload", exact: true }).click();
          await page.getByText("Page 1", { exact: true }).waitFor();
          await rows.waitFor();
          assert.equal(await newer.count(), 0);
          assert.equal(
            await page.getByRole("status", { name: "History filters", exact: true }).count(),
            1,
          );
          assert.deepEqual(errors, []);
        } catch (error) {
          await capture("first-failure");
          if (artifacts)
            writeFileSync(
              join(artifacts, `${label}-requests.json`),
              JSON.stringify(
                fixture.requests.map(({ kind, phase, input, aborted }) => ({
                  kind,
                  phase,
                  input,
                  aborted,
                })),
                null,
                2,
              ),
            );
          throw error;
        }
      },
    );

for (const width of [1280, 390])
  test(
    `filtered History resets page 2 after an authority revision at ${width}px`,
    { timeout: 60_000 },
    async (t) => {
      const fixture = await historyFixture({
        initialRequests: 25,
        pageSize: 10,
        diagnostic: (message) => t.diagnostic(message),
      });
      t.after(() => fixture.close());
      const { page, context, errors } = await fixture.page(width, { search: "?lab=codex" });
      t.after(() => context.close());
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByText("Page 2", { exact: true }).waitFor();
      const start = fixture.requests.length;
      fixture.hold("series");
      fixture.change("membership");
      await fixture.waitFor(
        () => fixture.requests.slice(start).some(({ kind }) => kind === "series"),
        { name: `authority ${width}px refresh series` },
      );
      const reading = page.getByText("Reading retained history…", { exact: true });
      await reading.waitFor();
      assert.equal(
        await page.getByRole("region", { name: "Request history", exact: true }).count(),
        0,
      );
      fixture.release();
      await reading.waitFor({ state: "hidden" });
      const artifacts = process.env.HISTORY_UI_ARTIFACTS;
      if (artifacts) {
        mkdirSync(artifacts, { recursive: true });
        await page.locator("body").screenshot({ path: join(artifacts, `authority-${width}.png`) });
      }
      assert.equal(await page.getByText("Page 1", { exact: true }).count(), 1);
      assert.equal(
        await page.getByRole("region", { name: "Request history", exact: true }).count(),
        1,
      );
      assert.equal(
        await page.getByText("Newer usage arrived. Reload to include it.", { exact: true }).count(),
        0,
      );
      assert.deepEqual(errors, []);
    },
  );
