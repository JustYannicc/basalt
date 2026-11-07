import assert from "node:assert/strict";
import { Effect } from "effect";
import { hostedScopes, sorted } from "./expectations.mjs";
export const verifyRefusedGrant = ({
  browser,
  request,
  path,
  prefix,
  omitsGrantedScope,
  refusedScope,
  noOverflow,
  added,
  before,
  links,
}) =>
  Effect.gen(function* () {
    const connection = yield* request(
      "POST",
      `${path}/accounts/user/planetscaleSignIn/connections`,
      {},
    );
    const attempt = yield* request("POST", `${prefix}/connections/${connection.id}/oauth/start`, {
      method: "signIn",
    });
    yield* browser.use(
      "A missing hosted permission is shown before saving an account",
      async (page) => {
        await page.goto(attempt.authorizationUrl);
        await page
          .getByRole("heading", { name: "PlanetScale test authorization", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Authorize", exact: true }).click();
        const failed = page.getByRole("heading", { name: "Account not connected", exact: true });
        const saved = page.getByRole("dialog", { name: "Name this account", exact: true });
        await failed.or(saved).waitFor();
        assert.equal(await saved.count(), 0, "A missing required grant must not save an account");
        await failed.waitFor();
        await page
          .getByText("Your existing sign-in and connected apps still work.", { exact: true })
          .waitFor();
        if (omitsGrantedScope) {
          await page
            .getByText(
              "The service did not report its granted permissions. Ask the app owner to check the service's token response before trying again.",
              { exact: true },
            )
            .waitFor();
        } else {
          await page.getByText("Not granted", { exact: true }).waitFor();
          await page.getByText(refusedScope, { exact: true }).waitFor();
        }
        await page.getByRole("link", { name: "Return to Accounts", exact: true }).waitFor();
        await page.getByText("Access details", { exact: true }).click();
        const detail = page
          .locator("details")
          .filter({ has: page.getByText("Access details", { exact: true }) });
        const values = (label) =>
          detail
            .locator("dl > div")
            .filter({ has: page.getByText(label, { exact: true }) })
            .locator("dd li > span:last-child")
            .allTextContents();
        assert.deepEqual(sorted(await values("Requested")), sorted(hostedScopes));
        if (omitsGrantedScope)
          await detail.getByText("Not reported by the service.", { exact: true }).waitFor();
        else
          assert.deepEqual(
            sorted(await values("Granted")),
            sorted(hostedScopes.filter((scope) => scope !== refusedScope)),
          );
        await noOverflow(page);
      },
    );
    const failure = yield* request("GET", `${prefix}/connections/${connection.id}`);
    assert.equal(failure.state.status, "pending");
    assert.equal(failure.state.failure.error.reason, "scope_missing");
    assert.deepEqual(sorted(failure.state.failure.error.requestedScopes), sorted(hostedScopes));
    if (omitsGrantedScope) {
      assert.equal(failure.state.failure.error.grantedScopes, undefined);
      assert.deepEqual(sorted(failure.state.failure.error.missingScopes), sorted(hostedScopes));
      assert.equal(failure.state.failure.error.grantedScopesKnown, false);
    } else {
      assert.deepEqual(
        sorted(failure.state.failure.error.grantedScopes),
        sorted(hostedScopes.filter((scope) => scope !== refusedScope)),
      );
      assert.deepEqual(failure.state.failure.error.missingScopes, [refusedScope]);
      assert.equal(failure.state.failure.error.grantedScopesKnown, true);
    }
    assert.equal(failure.state.failure.error.scopeNamesOmitted, false);
    assert.deepEqual(added(before, yield* links()), [], "No account is saved or linked");
    yield* browser.checkpoint("PlanetScale refused hosted scope is explicit and recoverable");
  });
