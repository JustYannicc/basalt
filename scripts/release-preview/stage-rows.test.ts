import assert from "node:assert/strict";
import { test } from "node:test";
import { stateEvidence } from "./stage-rows.ts";

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
