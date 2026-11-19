import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { StateStoreError } from "alchemy/State/State";
import { releaseSettlementKey } from "./release-settlement-contract.ts";
import { assertReleaseSettlementArchiveAbsent } from "./release-settlement-operation.ts";
import { stateApiFixture, fullToken } from "../upstream-tests/state-readonly-fixture.ts";

const source = "5f27c105862180cf2d6b34abdf870ded0aafd672";
const target = "1008410f6a0a2e66ece14122220aab67c21c140a";
const scope = { name: "basalt", stage: "production" };

test("a settlement archive crosses the pinned State HTTP router and client with full identities", async (context) => {
  const fixture = await stateApiFixture();
  context.after(fixture.dispose);
  const requests: Array<{ method: string; path: string; status: number }> = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const response = await fixture.handler(request);
    requests.push({
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
    });
    return response;
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  const state = await run(
    makeHttpStateStore({
      id: "settlement-http-fixture",
      url: "https://state.example.test",
      authToken: fullToken,
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const key = releaseSettlementKey(scope, source, target);
  assert.equal(await run(state.getOutput(key)), undefined);
  await run(assertReleaseSettlementArchiveAbsent(state, scope, source, target));
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(
    requests.map(({ method, status }) => ({ method, status })),
    [
      { method: "GET", status: 200 },
      { method: "GET", status: 200 },
    ],
  );
  const archive = { manifest: { sourceCandidate: source, candidate: target }, sealed: "fixture" };
  await run(state.setOutput({ ...key, value: archive }));
  assert.deepEqual(await run(state.getOutput(key)), archive);
  await assert.rejects(
    run(assertReleaseSettlementArchiveAbsent(state, scope, source, target)),
    /release-settlement-already-recorded-inspect-required/,
  );
  assert.deepEqual(fixture.writes, ["setOutput"]);
  assert.equal(new Set(requests.map(({ path }) => path)).size, 1);
  assert.equal(
    await run(state.getOutput(releaseSettlementKey(scope, `${source.slice(0, -1)}3`, target))),
    undefined,
  );
  assert.equal(
    await run(state.getOutput(releaseSettlementKey(scope, source, `${target.slice(0, -1)}b`))),
    undefined,
  );

  const legacyStack = `${scope.name}-release-settlement-${source}-${target}`;
  assert.equal(legacyStack.length, 107);
  await assert.rejects(
    run(state.getOutput({ stack: legacyStack, stage: scope.stage })),
    (error: unknown) => error instanceof StateStoreError && error.http?.status === 404,
  );
  assert.deepEqual(fixture.writes, ["setOutput"]);
});
