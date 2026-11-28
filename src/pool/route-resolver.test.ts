import assert from "node:assert/strict";
import { test } from "node:test";
import fixture from "./route-resolution.fixture.json" with { type: "json" };
import {
  routeResolutionPath,
  routeResolutionPrefix,
  toolsRouteResolver,
} from "./route-resolver.ts";
import { openEnvelope } from "./token.ts";

function service(answer: (body: { envelope: string }) => Response) {
  const calls: { url: string; body: { envelope: string } }[] = [];
  return {
    calls,
    fetch: async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { envelope: string };
      calls.push({ url, body });
      return answer(body);
    },
  };
}

test("the pool's request is exactly the golden fixture P4a serves, and its answer decodes as written", async () => {
  assert.equal(fixture.prefix, routeResolutionPrefix);
  assert.equal(fixture.path, routeResolutionPath);
  const tools = service(() => Response.json(fixture.resolve.response.body));
  const resolver = toolsRouteResolver(tools, fixture.signingKey, () => fixture.resolve.payload.at);
  const result = await resolver.resolve(
    fixture.scope,
    fixture.resolve.payload.references,
    AbortSignal.timeout(1_000),
  );
  assert.deepEqual(tools.calls, [
    { url: `https://tools${fixture.path}`, body: fixture.resolve.request },
  ]);
  assert.deepEqual(
    await openEnvelope(fixture.signingKey, fixture.prefix, fixture.resolve.request.envelope),
    fixture.resolve.payload,
  );
  assert.equal(result.served, true);
  assert.equal(result.revision, 7);
  assert.deepEqual(
    Object.fromEntries(result.resolutions),
    fixture.resolve.response.body.resolutions,
  );
  const poll = service(() => Response.json(fixture.poll.response.body));
  const polled = await toolsRouteResolver(
    poll,
    fixture.signingKey,
    () => fixture.poll.payload.at,
  ).resolve(fixture.scope, [], AbortSignal.timeout(1_000));
  assert.equal(polled.revision, 7);
  assert.deepEqual(poll.calls[0]!.body, fixture.poll.request);
});

test("a tools service without route rules answers not served; any other failure throws", async () => {
  const references = fixture.resolve.payload.references;
  const absent = toolsRouteResolver(
    service(() => new Response(null, { status: 404 })),
    fixture.signingKey,
  );
  const direct = await absent.resolve(fixture.scope, references, AbortSignal.timeout(1_000));
  assert.equal(direct.served, false);
  assert.deepEqual(
    [...direct.resolutions.values()],
    references.map(() => ({ routeId: null, owner: null })),
  );
  for (const failure of [
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 503 }),
    () => Response.json({ revision: "7", resolutions: {} }),
  ]) {
    await assert.rejects(
      toolsRouteResolver(service(failure), fixture.signingKey).resolve(
        fixture.scope,
        references,
        AbortSignal.timeout(1_000),
      ),
    );
  }
  // A malformed entry is left unresolved, which the caller treats as a failed pass.
  const partial = toolsRouteResolver(
    service(() =>
      Response.json({
        revision: 7,
        resolutions: { [references[0]!]: { routeId: 5, owner: null } },
      }),
    ),
    fixture.signingKey,
  );
  assert.equal(
    (await partial.resolve(fixture.scope, references, AbortSignal.timeout(1_000))).resolutions.size,
    0,
  );
});

test("more than 2,000 references go in bounded batches", async () => {
  const references = Array.from({ length: 4_001 }, (_, index) => `ref-${index}`);
  const tools = service(() => Response.json({ revision: 3, resolutions: {} }));
  await toolsRouteResolver(tools, fixture.signingKey).resolve(
    fixture.scope,
    references,
    AbortSignal.timeout(1_000),
  );
  const sizes = await Promise.all(
    tools.calls.map(
      async (call) =>
        (
          (await openEnvelope(fixture.signingKey, fixture.prefix, call.body.envelope)) as {
            references: string[];
          }
        ).references.length,
    ),
  );
  assert.deepEqual(sizes, [2_000, 2_000, 1]);
});
