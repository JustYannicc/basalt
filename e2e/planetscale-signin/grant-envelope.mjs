import assert from "node:assert/strict";
import { Effect } from "effect";

/** Unknown grant names must still fail through the real callback and save no account. */
export const verifyExceededGrant = ({ browser, request, path, prefix, added, links, before }) =>
  Effect.gen(function* () {
    const connection = yield* request(
      "POST",
      `${path}/accounts/user/planetscaleSignIn/connections`,
      {},
    );
    const attempt = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "signIn",
    });
    yield* browser.use("An unknown PlanetScale scope is refused", async (page) => {
      await page.goto(attempt.authorizationUrl);
      await page.getByRole("button", { name: "Authorize", exact: true }).click();
      const failure = page.getByRole("heading", { name: "Account not connected", exact: true });
      const saved = page.getByRole("dialog", { name: "Name this account", exact: true });
      await failure.or(saved).waitFor();
      assert.equal(await saved.count(), 0);
      await failure.waitFor();
    });
    const state = yield* request("GET", `${prefix}/connections/${connection.id}`);
    assert.equal(state.state.status, "pending");
    assert.equal(state.state.failure.error.reason, "scope_exceeded");
    assert.deepEqual(
      added(before, yield* links()),
      [],
      "Unknown access saves and links no account",
    );
    yield* browser.checkpoint("Unknown PlanetScale scope refused");
  });
