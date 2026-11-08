import assert from "node:assert/strict";
import { Effect } from "effect";
import { Browser } from "../../.upstream/e2e/support/browser.ts";
import { hostedScopes, sorted } from "./expectations.mjs";

/** Reconnect the same legacy account through the current operator client, without changing its provider. */
export const verifyRetainedReconnect = ({
  body,
  raw,
  prefix,
  appPath,
  oauth,
  retainedIds,
  width,
}) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const connection = yield* body("POST", `${appPath}/accounts/user/planetscale/connections`, {
      account: oauth.id,
    });
    return yield* Effect.gen(function* () {
      const start = yield* body("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
        method: "oauth2",
      });
      const requested = new URL(start.authorizationUrl).searchParams.get("scope").split(" ");
      assert.deepEqual(
        sorted(requested),
        sorted(hostedScopes),
        "A legacy reconnect uses the current operator's exact 33 scopes",
      );
      yield* browser.use("Reconnect the retained legacy OAuth account", async (page) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(start.authorizationUrl);
        await page
          .getByRole("heading", { name: "PlanetScale test authorization", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Authorize", exact: true }).click();
        await page.getByRole("region", { name: "Your accounts", exact: true }).waitFor();
      });
      const completed = yield* body("GET", `${prefix}/connections/${connection.id}`);
      assert.equal(completed.state.status, "completed");
      assert.equal(completed.state.account.id, oauth.id);
      const after = yield* body("GET", `${appPath}/accounts/user`);
      assert.deepEqual(
        after
          .filter((link) => link.requirement === "planetscale")
          .map(({ account }) => account.id)
          .sort(),
        retainedIds,
      );
      yield* browser.checkpoint("PlanetScale retained OAuth reconnected with the same account");
      return requested;
    }).pipe(
      Effect.ensuring(
        raw("POST", `${prefix}/connections/${connection.id}/cancel`).pipe(Effect.asVoid),
      ),
    );
  });
