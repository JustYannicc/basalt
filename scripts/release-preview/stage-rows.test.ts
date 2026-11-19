import { describe, expect, it } from "vitest";
import { stateEvidence } from "./stage-rows.ts";

describe("stateEvidence", () => {
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

  it("keeps hash slots and env fingerprints, never values", () => {
    const evidence = stateEvidence(rows, ["ArtifactsCredentials", "Formatter"]);
    expect(evidence.Formatter).toBeNull();
    const row = evidence.ArtifactsCredentials as {
      hash: Record<string, string | null>;
      env: Record<string, string>;
      bindings: string[];
    };
    expect(row.hash).toEqual({
      bundle: "a".repeat(16),
      metadata: "b".repeat(16),
      assets: null,
      input: null,
    });
    expect(Object.keys(row.env)).toEqual(["RUN", "TOKEN"]);
    expect(JSON.stringify(evidence)).not.toContain("secret-value");
    expect(row.bindings).toEqual(["Store"]);
  });

  it("gives the same fingerprint for the same value, a different one when it changes", () => {
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
    const env = (value: unknown) => (value as { env: Record<string, string> }).env;
    expect(env(again.ArtifactsCredentials)).toEqual(env(stateEvidence(rows).ArtifactsCredentials));
    expect(env(changed.ArtifactsCredentials).RUN).not.toBe(env(again.ArtifactsCredentials).RUN);
    expect(env(changed.ArtifactsCredentials).TOKEN).toBe(env(again.ArtifactsCredentials).TOKEN);
  });
});
