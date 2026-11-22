import assert from "node:assert/strict";
import { test } from "node:test";
import { recordedOrigins, recordedWorkerProps, stateEvidence } from "./stage-rows.ts";

const rows = [
  {
    path: "basalt-rehearsal/test-rehearsal-2/ArtifactsCredentials",
    value: {
      status: "updated",
      attr: { hash: { bundle: "a".repeat(64), metadata: "b".repeat(64) } },
      props: { main: "x.ts", env: { RUN: "1", TOKEN: "secret-value" } },
      bindings: [{ sid: "Store", data: {} }],
    },
  },
];
const env = (value: unknown) => (value as { env: Record<string, string> }).env;

test("stateEvidence keeps hash slots and env fingerprints, never values", () => {
  const evidence = stateEvidence(rows, ["ArtifactsCredentials", "Formatter"]);
  assert.equal(evidence.Formatter, null);
  const row = evidence.ArtifactsCredentials as {
    hash: Record<string, string | null>;
    env: Record<string, string>;
    bindings: string[];
  };
  assert.deepEqual(row.hash, {
    bundle: "a".repeat(16),
    metadata: "b".repeat(16),
    assets: null,
    input: null,
  });
  assert.deepEqual(Object.keys(row.env), ["RUN", "TOKEN"]);
  assert.ok(!JSON.stringify(evidence).includes("secret-value"));
  assert.deepEqual(row.bindings, ["Store"]);
});

test("stateEvidence gives the same fingerprint for the same value, a different one when it changes", () => {
  const again = stateEvidence(rows, ["ArtifactsCredentials"]);
  const changed = stateEvidence(
    [
      {
        ...rows[0]!,
        value: { ...rows[0]!.value, props: { env: { RUN: "2", TOKEN: "secret-value" } } },
      },
    ],
    ["ArtifactsCredentials"],
  );
  assert.deepEqual(env(again.ArtifactsCredentials), env(stateEvidence(rows).ArtifactsCredentials));
  assert.notEqual(env(changed.ArtifactsCredentials).RUN, env(again.ArtifactsCredentials).RUN);
  assert.equal(env(changed.ArtifactsCredentials).TOKEN, env(again.ArtifactsCredentials).TOKEN);
});

test("recorded Worker rows keep only build, assets and hashes, never a host, id, URL or secret", () => {
  const account = "a".repeat(32);
  const zone = "b".repeat(32);
  const rows = [
    {
      path: "basalt-rehearsal/test-rehearsal-6/Sso",
      value: {
        status: "updated",
        props: {
          main: "src/sso.ts",
          accountId: account,
          env: { SSO_SECRET: "secret-value-1" },
          bindings: [{ name: "DB", value: "binding-value-1" }],
          routes: [{ pattern: "app.rehearsal-6.example.dev/*", zoneId: zone }],
          domain: "sso.rehearsal-6.example.dev",
          build: { entry: "src/sso.ts", hash: "f".repeat(64), url: "https://cdn.example.dev/x" },
          assets: { directory: "public", manifest: `zone-${zone}` },
          signingKey: "secret-value-2",
        },
        bindings: [
          { sid: "DB", data: "binding-value-2" },
          { sid: "HD", data: { hyperdrives: { [zone]: { origin: "binding-value-3" } } } },
        ],
        attr: {
          hash: { bundle: "c".repeat(64), metadata: "d".repeat(64), assets: null },
          url: "https://sso.rehearsal-6.example.dev",
          accountId: account,
          workerId: "basalt-rehearsal-sso-test-rehearsal-6",
          workerName: "basalt-rehearsal-sso-test-rehearsal-6",
          routes: [{ id: zone, pattern: "sso.rehearsal-6.example.dev/*", zoneId: zone }],
          crons: [],
          domains: [{ id: account, hostname: "sso.rehearsal-6.example.dev" }],
        },
      },
    },
  ];
  const out = recordedWorkerProps(rows, ["Sso", "Missing"]);
  const text = JSON.stringify(out);
  for (const leak of [
    account,
    zone,
    "example.dev",
    "https://",
    "secret-value-1",
    "secret-value-2",
    "binding-value-1",
    "binding-value-2",
    "binding-value-3",
    'src/sso.ts","accountId',
  ])
    assert.equal(text.includes(leak), false, leak);
  const sso = out.Sso as Record<string, unknown>;
  assert.equal(sso.status, "updated");
  assert.deepEqual(sso.build, { entry: "src/sso.ts", hash: "f".repeat(64), url: "[filtered]" });
  assert.deepEqual(sso.assets, { directory: "public", manifest: "[filtered]" });
  assert.deepEqual(sso.hash, { bundle: "c".repeat(64), metadata: "d".repeat(64), assets: null });
  assert.deepEqual(sso.propKeys, {
    main: "string",
    accountId: "string",
    env: { SSO_SECRET: "string" },
    bindings: [{ name: "string", value: "string" }],
    routes: [{ pattern: "string", zoneId: "string" }],
    domain: "string",
    signingKey: "string",
  });
  // A map keyed by a resource id keeps its shape; the id itself shows only as `[id n]`.
  assert.deepEqual(sso.stateBindings, [
    { sid: "string", data: "string" },
    { sid: "string", data: { hyperdrives: { "[id 1]": { origin: "string" } } } },
  ]);
  assert.deepEqual(sso.attrKeys, [
    "accountId",
    "crons",
    "domains",
    "hash",
    "routes",
    "url",
    "workerId",
    "workerName",
  ]);
  assert.equal(sso.workerIdEmptyOrName, true);
  assert.deepEqual(sso.counts, { routes: 1, crons: 0, domains: 1 });
  assert.deepEqual(out.Missing, {
    status: null,
    build: undefined,
    assets: undefined,
    hash: {},
    propKeys: {},
    stateBindings: "undefined",
    attrKeys: [],
    workerIdEmptyOrName: true,
    counts: { routes: null, crons: null, domains: null },
  });
  // A recorded id that is neither empty nor the script's name reads false, and still never leaves.
  const other = recordedWorkerProps(
    [{ path: "s/t/Api", value: { attr: { workerId: account, workerName: "basalt-api" } } }],
    ["Api"],
  );
  assert.equal((other.Api as { workerIdEmptyOrName: boolean }).workerIdEmptyOrName, false);
  assert.equal(JSON.stringify(other).includes(account), false);
});

test("a database connection's origin shows its key names and whether a password is there, never a value", () => {
  const origin = {
    host: "db-host.example.dev",
    port: 5432,
    user: "secret-user-1",
    password: "secret-password-1",
    database: "secret-db-1",
  };
  const rows = [
    {
      path: "s/t/DatabaseConnection",
      value: {
        props: { name: "x", origin },
        attr: { origin: { host: "db-host.example.dev", user: "secret-user-1" } },
      },
    },
    { path: "s/t/PoolModelDatabaseConnection", value: { props: { name: "y" }, attr: {} } },
  ];
  const out = recordedOrigins(rows, [
    "DatabaseConnection",
    "PoolModelDatabaseConnection",
    "Missing",
  ]);
  const text = JSON.stringify(out);
  for (const leak of ["db-host", "secret-user-1", "secret-password-1", "secret-db-1", "5432"])
    assert.equal(text.includes(leak), false, leak);
  assert.deepEqual(out.DatabaseConnection, {
    props: { keys: ["database", "host", "password", "port", "user"], password: true },
    output: { keys: ["host", "user"], password: false },
  });
  assert.deepEqual(out.PoolModelDatabaseConnection, { props: "absent", output: "absent" });
  assert.equal(out.Missing, "no row");
});
