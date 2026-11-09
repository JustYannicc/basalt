import assert from "node:assert/strict";
import { test } from "node:test";
import { historyFixture } from "./history-fixture.mjs";

test("history reports retained request coverage, and a later checked watermark cannot advance it", async (t) => {
  const fixture = await historyFixture();
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
});
