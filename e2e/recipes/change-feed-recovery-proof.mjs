import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import { roleHost } from "../../.upstream/e2e/support/role-hosts.ts";

/** Move real authoritative fixture heads without hints, then exercise the actual failed view. */
export const changeFeedRecoveryProof = ({
  h,
  browser,
  database,
  label,
  check,
  diagnostics,
  directory,
  accountReads,
}) =>
  Effect.gen(function* () {
    diagnostics.recovery = [];
    for (const manual of [false, true]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const mode = manual ? "manual" : "automatic";
          const progress = { mode, phase: "connect", heads: [], reads: 0, errors: [] };
          diagnostics.recovery.push(progress);
          const videoDirectory = join(directory, `recovery-${mode}-raw`);
          yield* Effect.promise(() => mkdir(videoDirectory, { recursive: true }));
          let moving = true,
            closing = false,
            releaseApps = () => {},
            page,
            writes = Promise.resolve();
          const context = yield* Effect.acquireRelease(
            Effect.promise(() =>
              browser.newContext({
                viewport: { width: 390, height: 960 },
                ignoreHTTPSErrors: true,
                recordVideo: { dir: videoDirectory, size: { width: 390, height: 960 } },
              }),
            ),
            (context) =>
              Effect.promise(async () => {
                closing = true;
                moving = false;
                releaseApps();
                if (page && progress.phase !== "complete")
                  await page
                    .screenshot({
                      path: join(directory, `recovery-${mode}-failure.png`),
                      fullPage: true,
                    })
                    .catch(() => {});
                try {
                  await writes;
                } finally {
                  const video = page?.video();
                  await context.close();
                  if (video)
                    await copyFile(await video.path(), join(directory, `recovery-${mode}.webm`));
                }
              }),
          );
          const cookies = Redacted.value(yield* h.actors.owner.cookies);
          yield* Effect.promise(() => context.addCookies([...cookies]));
          page = yield* Effect.promise(() => context.newPage());
          const origin = roleHost(h.origin, "app"),
            organization = `/org/${h.actors.organization.slug}`;
          let appsRequested;
          const requested = new Promise((resolve) => {
            appsRequested = resolve;
          });
          const released = new Promise((resolve) => {
            releaseApps = resolve;
          });
          yield* Effect.promise(() =>
            page.route(
              /\/assets\/org\._organizationSlug\.apps\.index-[^/]+\.js$/,
              async (route) => {
                appsRequested();
                await released;
                await route.continue().catch(() => {});
              },
            ),
          );
          yield* Effect.promise(() =>
            page.route(/\/changes\/current(?:\?|$)/, async (changeHeadRoute) => {
              try {
                const response = await changeHeadRoute.fetch();
                assert.equal(
                  response.status(),
                  200,
                  "the head receipt comes from the real authorized route",
                );
                const receipt = await response.json();
                if (moving) {
                  // Direct fixture checkpoints reproduce a missed final hint; no HTTP head or body is forged.
                  writes = writes.then(() =>
                    Effect.runPromise(
                      database.run({
                        sql: "update hosted_change_heads set revision=revision+1 where scope=$1 and topic='accounts' and resource='*' returning revision::text",
                        params: [`organization:${h.actors.organization.id}`],
                      }),
                    ),
                  );
                  const rows = await writes;
                  assert.equal(
                    rows.length,
                    1,
                    "only this synthetic organization's account head changes",
                  );
                  progress.heads.push({
                    before: receipt.revisions.filter((hint) => hint.topic === "accounts"),
                    committed: rows[0].revision,
                  });
                }
                await changeHeadRoute.fulfill({ response });
              } catch (error) {
                if (!closing && !page.isClosed()) progress.errors.push(String(error));
                await changeHeadRoute.abort().catch(() => {});
              }
            }),
          );
          page.on("request", (request) => {
            progress.reads += accountReads(request);
          });
          yield* Effect.promise(() => page.goto(`${origin}${organization}/connect`));
          yield* Effect.promise(() =>
            page.evaluate(
              (path) => window.history.pushState(window.history.state, "", path),
              `${organization}/apps`,
            ),
          );
          yield* Effect.promise(() => requested).pipe(Effect.timeout("15 seconds"));
          progress.phase = "overlap";
          const started = Date.now();
          yield* Effect.promise(() =>
            page.evaluate(
              (path) => window.history.pushState(window.history.state, "", path),
              `${organization}/accounts`,
            ),
          );
          const failure = page.getByText(/Couldn't confirm the latest changes/).first();
          yield* Effect.promise(() => failure.waitFor({ timeout: 15_000 }));
          progress.failedAfterMs = Date.now() - started;
          check(
            `Controlled ${mode}: real overlap reaches the unchanged fail-closed panel`,
            progress.heads.length >= 6,
            true,
          );
          yield* Effect.promise(() =>
            page.screenshot({
              path: join(directory, `recovery-${mode}-before.png`),
              fullPage: true,
            }),
          );
          moving = false;
          progress.phase = "settled";
          progress.stableAfterMs = Date.now() - started;
          if (manual)
            yield* Effect.promise(() =>
              page.getByRole("button", { name: "Retry", exact: true }).first().click(),
            );
          // This is the original first-entry content budget, measured from the navigation, not a new wait.
          yield* Effect.promise(() =>
            page
              .getByText(label, { exact: true })
              .first()
              .waitFor({ timeout: Math.max(1, 15_000 - (Date.now() - started)) }),
          );
          progress.contentAfterMs = Date.now() - started;
          check(
            `Controlled ${mode}: content appears within the unchanged 15-second deadline`,
            progress.contentAfterMs < 15_000,
            true,
          );
          check(
            `Controlled ${mode}: authoritative receipt interception has no errors`,
            progress.errors,
            [],
          );
          yield* Effect.promise(() =>
            page.screenshot({
              path: join(directory, `recovery-${mode}-after.png`),
              fullPage: true,
            }),
          );
          progress.phase = "complete";
        }),
      );
    }
  });
