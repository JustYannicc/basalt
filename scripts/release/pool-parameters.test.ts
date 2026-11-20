import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  declaredPoolParameters,
  poolParameterLine,
  poolParameterReport,
  readPoolParameters,
} from "./pool-parameters.ts";

// The provider's answer as it would arrive: the eight settings plus unrelated rows.
const answer = (convert: (value: string) => unknown, change: Record<string, unknown> = {}) => [
  ...declaredPoolParameters.map(({ namespace, name, declared }) => ({
    namespace,
    name,
    value: name in change ? change[name] : convert(declared),
  })),
  { namespace: "pgconf", name: "unrelated_setting", value: "private-sentinel" },
  { namespace: "pgconf", name: "pginsights.enabled", value: null },
];

test("a string answer that matches the policy reports every setting equal with its value and type", () => {
  const report = poolParameterReport(answer(String));
  assert.equal(report.settings.length, 8);
  assert.ok(report.settings.every((entry) => entry.status === "equal" && entry.type === "string"));
  assert.deepEqual(
    report.settings.find((entry) => entry.setting === "pgconf.max_connections"),
    {
      setting: "pgconf.max_connections",
      declared: "50",
      value: "50",
      type: "string",
      status: "equal",
    },
  );
  assert.equal(report.poolerReload, false);
  const line = poolParameterLine(report);
  assert.match(line, /pgbouncer\.default_pool_size equal \("5", string\)/);
  assert.doesNotMatch(line, /Warning|private-sentinel|unrelated|pginsights/);
});

test("a number answer is reported with its type, and the budget step would see it as different", () => {
  const report = poolParameterReport(
    answer((value) => (/^\d+$/.test(value) ? Number(value) : value)),
  );
  const slots = report.settings.find((entry) => entry.setting === "pgconf.max_connections")!;
  assert.deepEqual(slots, {
    setting: "pgconf.max_connections",
    declared: "50",
    value: 50,
    type: "number",
    status: "differs",
  });
  assert.equal(
    report.settings.find((entry) => entry.setting === "pgbouncer.pool_mode")!.status,
    "equal",
  );
  // The budget step compares strings, so numeric pooler values would make it patch the pooler.
  assert.equal(report.poolerReload, true);
  assert.equal(report.budgetRefuses, false);
  const line = poolParameterLine(report);
  assert.match(line, /pgconf\.max_connections differs \(50, number\)/);
  assert.match(line, /would PATCH it and reload the pooler/);
});

test("a differing pooler value warns of a reload, a missing one is absent, and other pooling modes warn of a refusal", () => {
  const report = poolParameterReport(
    answer(String, { default_pool_size: "20", server_lifetime: undefined, pool_mode: "session" }),
  );
  const by = (setting: string) => report.settings.find((entry) => entry.setting === setting)!;
  assert.deepEqual(
    [by("pgbouncer.default_pool_size").status, by("pgbouncer.default_pool_size").value],
    ["differs", "20"],
  );
  assert.deepEqual(
    [by("pgbouncer.server_lifetime").status, by("pgbouncer.server_lifetime").type],
    ["differs", "absent"],
  );
  assert.equal(report.poolerReload, true);
  assert.equal(report.budgetRefuses, true);
  assert.match(poolParameterLine(report), /not in transaction pooling, so .* would refuse/);
});

test("reading the parameters sends exactly one GET to the branch's parameters path", async () => {
  const requests: { method: string; path: string; authorization?: string }[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.authorization,
      });
      return HttpClientResponse.fromWeb(request, Response.json(answer(String)));
    }),
  );
  const report = await Effect.runPromise(
    readPoolParameters({
      organization: "fixture-org",
      tokenId: Redacted.make("fixture-id"),
      token: Redacted.make("fixture-token"),
      database: "fixture-db",
      branch: "main",
      apiOrigin: "https://provider.invalid/v1",
    }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
  );
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/v1/organizations/fixture-org/databases/fixture-db/branches/main/parameters",
      authorization: "fixture-id:fixture-token",
    },
  ]);
  assert.equal(report.poolerReload, false);
  assert.doesNotMatch(JSON.stringify(report), /fixture-token|fixture-id|private-sentinel/);
});

test("a failed answer fails the read rather than reporting settings", async () => {
  const http = HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: 503 }))),
  );
  await assert.rejects(
    Effect.runPromise(
      readPoolParameters({
        organization: "fixture-org",
        tokenId: Redacted.make("fixture-id"),
        token: Redacted.make("fixture-token"),
        database: "fixture-db",
        branch: "main",
        apiOrigin: "https://provider.invalid/v1",
      }).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    ),
  );
});
