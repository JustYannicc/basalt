import assert from "node:assert/strict";
import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { controlRequest } from "../../.upstream/e2e/support/server-control.ts";

/** Use the old operator configuration to save a grant before rolling the same server forward. */
export async function legacyPlanetScaleScopes(root) {
  const source = JSON.parse(
    await readFile(join(root, "src/catalog/planetscale.published.json"), "utf8"),
  );
  const index = source.files.find((file) => file.path === "index.ts").content;
  const declaration = index.match(/oauth2: oauth2\(\{[\s\S]*?scopes:\s*\[([\s\S]*?)\]/)?.[1];
  assert.ok(declaration);
  const scopes = [...declaration.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(scopes.length, 28);
  return scopes;
}

/** The loopback control plane retains the fixture database across the operator upgrade. */
export const replaceHostedClient = (client) =>
  Effect.gen(function* () {
    yield* controlRequest("stop", 200);
    yield* controlRequest("environment", 200, {
      EXECUTOR_TEST_OAUTH_CLIENT_DEFINITIONS: JSON.stringify([client]),
    });
    yield* controlRequest("start", 200);
  });

export const upgradeAndExpireGrant = (client) =>
  replaceHostedClient(client).pipe(
    Effect.andThen(controlRequest("clock/advance", 200, { milliseconds: 7_201_000 })),
    Effect.asVoid,
  );
