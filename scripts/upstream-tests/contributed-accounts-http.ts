import { createRequire } from "node:module";
import { Effect, Layer } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { SqlClient } from "effect/sql";
import { load, implementation, contracts } from "./pool-access-fixture.ts";
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { layerHttpServices } = await import(require.resolve("@effect/platform-node/NodeHttpServer"));
const { HostedApi } = await load(`${contracts}api.ts`);
const { hostedAppAccountHandlers } = await load(`${implementation}app-account-links.ts`);
const { hostedResourceAccessHandlers } = await load(`${implementation}resource-access.ts`);
const { hostedOrganizationHandlers } = await load(`${implementation}organization.ts`);
const { requireAccountTargetLive } = await load(`${implementation}proofs/account-access.ts`);
const { Authentication, ApiAuthentication, RequireUser } = await load(`${contracts}auth.ts`);
const { RequireOrganization } = await load(`${contracts}organization.ts`);

/** Real endpoint decoding, response encoding and HTTP errors under native Better Auth sessions. */
export const contributedHttp = (f: any, scope: "appAccounts" | "organization" = "appAccounts") =>
  Effect.gen(function* () {
    const api =
      scope === "appAccounts"
        ? HttpApi.make(HostedApi.identifier).add(HostedApi.groups.appAccounts)
        : HttpApi.make(HostedApi.identifier).add(
            HostedApi.groups.resourceAccess,
            HostedApi.groups.organization,
          );
    // The fixture provides only what these routes read; the full host types aren't needed here.
    const web: any = HttpRouter.toWebHandler(
      (HttpApiBuilder.layer(api) as any).pipe(
        Layer.provide(
          scope === "appAccounts"
            ? hostedAppAccountHandlers
            : Layer.mergeAll(hostedResourceAccessHandlers, hostedOrganizationHandlers),
        ),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(RequireOrganization, (effect: any) => effect),
            Layer.succeed(RequireUser, (effect: any) => effect),
            Layer.succeed(Authentication, {
              origin: "http://localhost:3000",
              organizationSlug: () => Effect.succeed(f.org.slug),
            }),
            Layer.succeed(ApiAuthentication, {}),
            requireAccountTargetLive,
            layerHttpServices,
          ),
        ),
      ),
      {
        disableLogger: true,
        middleware: (effect: any) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const session: any = yield* Effect.promise(() =>
              f.auth.api.getSession({ headers: new Headers(request.headers) }),
            );
            if (session === null) return yield* HttpServerResponse.json({}, { status: 401 });
            const members =
              yield* f.sql`select id from member where "organizationId" = ${f.org.id} and "userId" = ${session.user.id}`;
            if (members.length !== 1) return yield* HttpServerResponse.json({}, { status: 403 });
            return yield* f.as(session.user, effect);
          }).pipe(Effect.provideService(SqlClient.SqlClient, f.sql)),
      },
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => web.dispose()));
    return (user: any, method: string, path = "", body?: unknown) =>
      Effect.promise(async () => {
        const headers = new Headers(user.headers);
        if (body !== undefined) headers.set("content-type", "application/json");
        return web.handler(
          new Request(
            `http://localhost:3000/api/organizations/${f.org.id}${scope === "appAccounts" ? `/apps/${f.app.id}/accounts/app` : ""}${path}`,
            {
              method,
              headers,
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          ),
        );
      });
  });
