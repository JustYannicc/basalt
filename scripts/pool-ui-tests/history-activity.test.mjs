import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { historyFixture } from "./history-fixture.mjs";

for (const hiddenBy of ["parent", "tab"]) {
  for (const hold of ["discovery", "bounded", "series"]) {
    test(`${hiddenBy} hiding aborts pending ${hold} and resumes history only when active`, async (t) => {
      const fixture = await historyFixture({ sourceRef: process.env.HISTORY_UI_SOURCE_REF });
      t.after(() => fixture.close());
      const { page, active, context, errors } = await fixture.page(1280);
      t.after(() => context.close());
      const artifacts = process.env.HISTORY_UI_ARTIFACTS;
      if (artifacts) {
        assert.ok(isAbsolute(artifacts) && !resolve(artifacts).startsWith(process.cwd() + "/"));
        mkdirSync(artifacts, { recursive: true });
        t.after(() =>
          writeFileSync(
            join(artifacts, `${hiddenBy}-${hold}.json`),
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
          ),
        );
      }
      await page.getByRole("radio", { name: "From / To", exact: true }).click();
      await page.getByLabel("From", { exact: true }).fill("2026-11-04");
      await page.getByLabel("To", { exact: true }).fill("2026-11-13");
      const initial = fixture.requests.length;
      fixture.hold(hold);
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await fixture.waitFor(() =>
        fixture.requests.slice(initial).some((request) => request.phase === hold),
      );
      const pending = fixture.requests.slice(initial).find((request) => request.phase === hold);
      if (artifacts && hiddenBy === "parent" && hold === "discovery")
        await page.locator("body").screenshot({ path: join(artifacts, "history-pending.png") });
      const count = fixture.requests.length;
      if (hiddenBy === "parent") await active(false);
      else await page.evaluate(() => window.hideTab());
      fixture.release();
      // Let the cancelled read settle through the hook and revision fence before counting.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.deepEqual(
        await page.evaluate(() =>
          window.historyHttpReads.filter(
            (read) => !read.active && !read.path.startsWith("/_executor/api/telemetry/"),
          ),
        ),
        [],
        "Hiding must stop HTTP at initiation, including the trailing revision-head read",
      );
      // A new caller while hidden must also be refused before it starts an HTTP read.
      await assert.rejects(
        page.evaluate(() => window.readHiddenHistory()),
        /Change read not accepted: hidden/,
      );
      // The server sees cancellation, rather than only discarding the eventual reply.
      await fixture.waitFor(() => pending.aborted);
      assert.equal(fixture.requests.length, count);
      if (hiddenBy === "parent") await active(true);
      else await page.evaluate(() => window.showTab());
      await fixture.waitFor(() =>
        fixture.requests
          .slice(count)
          .some((request) => request.phase === "series" && request.response.writableEnded),
      );
      await page.getByRole("region", { name: "Request history", exact: true }).waitFor();
      assert.ok(fixture.requests.length > count);
      if (artifacts && hiddenBy === "parent" && hold === "discovery")
        await page.locator("body").screenshot({ path: join(artifacts, "history-resumed.png") });
      assert.deepEqual(errors, []);
    });
  }
}
