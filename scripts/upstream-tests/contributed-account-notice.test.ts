import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { contributedFixture } from "./contributed-accounts-fixture.ts";
import { load, implementation, contracts } from "./pool-access-fixture.ts";

// Exercise the page renderer itself: notices used to bypass the account API's identity policy.
test("app page account problems hide acquired identity from other members", async () => {
  await contributedFixture((f) =>
    Effect.gen(function* () {
      const { hostedAppUi } = yield* Effect.promise(() => load(`${implementation}app-ui.ts`));
      const { appAddresses } = yield* Effect.promise(() =>
        load(`${implementation}app-addresses.ts`),
      );
      const { HostedAppSessions } = yield* Effect.promise(() => load(`${contracts}app-ui.ts`));
      const account = yield* f.connect(f.guest);
      yield* f.check(f.guest, account.id);
      yield* f.sql`update executor_account_checks set status = 'credentials_rejected' where account = ${account.id}`;
      const addresses = appAddresses("http://localhost:3000", "http://localhost", "opaque");
      const origin = yield* addresses.origin(f.app, f.org.slug);
      for (const user of [f.spare, f.guest, f.owner]) {
        const response = yield* f.as(
          user,
          hostedAppUi(addresses).page.pipe(
            Effect.provideService(HostedAppSessions, {
              organization: () => Effect.succeed({ id: f.org.id, slug: f.org.slug }),
              current: () => Effect.succeed({ userId: user.id }),
            }),
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(origin, {
                  headers: {
                    host: new URL(origin).host,
                    accept: "text/html",
                    cookie: `executor_app=${"a".repeat(64)}`,
                  },
                }),
              ),
            ),
          ),
        );
        const web = HttpServerResponse.toWeb(response);
        assert.equal(web.status, 409, yield* Effect.promise(() => web.clone().text()));
        const body = yield* Effect.promise(() => web.text());
        assert.equal(body.includes("upstream@example.invalid"), user !== f.spare, body);
        if (user === f.spare) assert.ok(body.includes("Connected account"), body);
      }
    }),
  );
});
