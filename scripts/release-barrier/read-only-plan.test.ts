import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack, evalStack } from "alchemy/Stack";
import * as Provider from "alchemy/Provider";
import { havePropsChanged } from "alchemy/Diff";
import { Resource } from "alchemy/Resource";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { State } from "alchemy/State/State";
import type { CreatedResourceState } from "alchemy/State/ResourceState";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { BarrierRefusal } from "./manifest.ts";
import { readOnlyPlan } from "./read-only-plan.ts";
import { releaseStackState, withReadOnlyPlanState } from "./read-only-state.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { releaseEvidence } from "./evidence.ts";
import { reportRefusal } from "./refusal-report.ts";
import {
  stateApiFixture,
  fullToken,
  readerToken,
  scope,
  scopePath,
} from "../upstream-tests/state-readonly-fixture.ts";

interface Fixture extends Resource<
  "Fixture.Unsupported",
  { instanceType: string },
  { id: string }
> {}
const Fixture = Resource<Fixture>("Fixture.Unsupported");
const stored = (id: string): CreatedResourceState => ({
  status: "created",
  resourceType: "Fixture.Unsupported",
  namespace: undefined,
  fqn: id,
  logicalId: id,
  instanceId: "fixture-instance",
  providerVersion: 1,
  downstream: [],
  bindings: [],
  props: { instanceType: "basic" },
  attr: { id },
});

for (const change of [false, true]) {
  test(`the actual stack preflight ${change ? "reports every refusal" : "admits a supported plan"} through read-only state without entering bootstrap or apply`, async (context) => {
    const api = await stateApiFixture();
    context.after(api.dispose);
    await api.provision();
    for (const id of ["First", "Second"])
      assert.equal(
        (await api.request("PUT", `${scopePath}/resources/${id}`, fullToken, stored(id))).status,
        200,
      );
    const writes = [...api.writes];
    const network: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      network.push(request.method);
      return api.handler(request);
    };
    let bootstraps = 0;
    let executions = 0;
    const fallback = Layer.effect(
      State,
      Effect.sync(() => {
        bootstraps++;
        throw new Error("Cloudflare.state must never initialize in preflight");
      }),
    );
    const stack = Stack(
      "fixture",
      {
        state: releaseStackState(fallback),
        providers: Provider.succeed(Fixture, {
          diff: ({ olds, news }) =>
            Effect.succeed({
              action: havePropsChanged(olds, news) ? "update" : "noop",
            }),
          reconcile: () =>
            Effect.sync(() => {
              executions++;
              throw new Error("Preflight must not reconcile or publish");
            }),
          delete: () =>
            Effect.sync(() => {
              executions++;
              throw new Error("Preflight must not remove resources");
            }),
        }),
      },
      Effect.gen(function* () {
        for (const id of ["First", "Second"])
          yield* Fixture(id, { instanceType: change ? "standard" : "basic" });
      }),
    );
    const scratch = await mkdtemp(join(tmpdir(), "readonly-plan-"));
    context.after(() => rm(scratch, { recursive: true, force: true }));
    const before = process.cwd();
    let result;
    try {
      process.chdir(scratch);
      result = await Effect.runPromiseExit(
        evalStack(
          stack,
          (compiled) => readOnlyPlan(compiled).pipe(Effect.provideContext(compiled.services)),
          { stage: "production" },
        ).pipe(
          withReleaseRuntime,
          withReadOnlyPlanState({
            url: "https://state.example.test",
            authToken: Redacted.make(readerToken),
            ...scope,
            expectedVersion: 8,
          }),
          Effect.provideService(FetchHttpClient.Fetch, fetch),
          Effect.provideService(AlchemyContext, {
            dotAlchemy: join(scratch, ".alchemy"),
            dev: false,
            adopt: false,
          }),
        ),
      );
    } finally {
      process.chdir(before);
    }
    assert.equal(bootstraps, 0);
    assert.equal(executions, 0);
    assert.deepEqual(api.writes, writes);
    assert.ok(network.length >= 5);
    assert.ok(network.every((method) => method === "GET"));
    if (change) {
      assert.ok(Exit.isFailure(result));
      const error = Cause.squash(result.cause);
      assert.ok(error instanceof BarrierRefusal);
      assert.equal(error.refusals?.length, 2);
      const failure = await releaseEvidence(scratch, "a".repeat(40)).failure(error);
      const output: string[] = [];
      const summary = join(scratch, "summary.md");
      await reportRefusal(failure, summary, (line) => output.push(line));
      assert.ok(
        output.some(
          (line) =>
            line.includes("First") && line.includes("Second") && line.includes("instanceType"),
        ),
      );
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(summary, "utf8");
      for (const expected of ["First", "Second", "basic", "standard", "instanceType"])
        assert.ok(content.includes(expected));
    } else {
      assert.ok(Exit.isSuccess(result));
      assert.deepEqual(result.value, { resources: 2 });
    }
  });
}
