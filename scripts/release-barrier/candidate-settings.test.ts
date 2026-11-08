import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverCandidateSettings } from "../architecture/native-stack.ts";
import { baselineRoles } from "./baseline-probe.ts";
import {
  CandidateSettingsReadFailure,
  candidateReadFailure,
  candidateFailureDetails,
} from "./candidate-failure.ts";

test("the exact CI candidate reader names the missing release Command input", () => {
  assert.deepEqual(discoverCandidateSettings(process.cwd(), "missing-attempt"), {
    ok: false,
    failure: {
      tag: "CandidateSettingsReadFailure",
      causeTag: "MissingInput",
      stage: "inputs",
      input: "BASALT_RELEASE_ATTEMPT",
    },
  });
});

test("a probe-scoped attempt reads all 20 real candidate declarations without deployment-only inputs", () => {
  const result = discoverCandidateSettings(process.cwd(), "ready");
  assert.ok(typeof result === "object" && result !== null && "roles" in result && "ok" in result);
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.roles));
  assert.deepEqual([...result.roles].sort(), [...baselineRoles].sort());
});

test("candidate errors retain only closed tags, stages and known input names", () => {
  for (const error of [new Error("private-fixture bearer token"), { _tag: "private-fixture" }]) {
    const safe = candidateReadFailure(error, "evaluate");
    assert.ok(safe instanceof CandidateSettingsReadFailure);
    assert.deepEqual(candidateFailureDetails(safe), {
      tag: "CandidateSettingsReadFailure",
      causeTag: "UnclassifiedFailure",
      stage: "evaluate",
    });
    assert.doesNotMatch(safe.message, /private-fixture|token/);
  }
});

for (const mode of ["entry-ready", "entry-missing-attempt"] as const)
  test(`the real CI entrypoint reports ${mode} with an owned Api inventory`, () => {
    const result = discoverCandidateSettings(process.cwd(), mode);
    assert.ok(typeof result === "object" && result !== null && "rows" in result);
    const { rows, summary, errors, namespaceReads } = result as {
      rows: {
        ok: boolean;
        role: string;
        reason?: string;
        candidateFailure?: unknown;
        compared?: string[];
      }[];
      summary: string;
      errors: string[];
      namespaceReads: number;
    };
    if (mode === "entry-ready") {
      assert.equal(rows.length, 20, JSON.stringify(result));
      assert.ok(
        rows.every((row) => row.ok),
        JSON.stringify(rows),
      );
      assert.ok(rows.every((row) => row.compared?.length === 8));
      assert.ok(namespaceReads >= 2);
      assert.deepEqual(errors, []);
    } else {
      assert.equal(rows.length, 20);
      assert.deepEqual(
        rows.map((row) => row.role),
        baselineRoles,
      );
      assert.deepEqual(rows[0]!.candidateFailure, {
        tag: "CandidateSettingsReadFailure",
        causeTag: "MissingInput",
        stage: "inputs",
        input: "BASALT_RELEASE_ATTEMPT",
      });
      assert.match(summary, /MissingInput; stage=inputs; input=BASALT_RELEASE_ATTEMPT/);
      assert.match(
        errors.join("\n"),
        /CandidateSettingsReadFailure; tag=MissingInput; stage=inputs; input=BASALT_RELEASE_ATTEMPT/,
      );
    }
  });

test("the actual CI reader probes healthy declarations after inventory refusals without inventing names", () => {
  const result = discoverCandidateSettings(process.cwd(), "entry-inventory-refusals");
  assert.ok(
    typeof result === "object" && result !== null && "rows" in result && "requests" in result,
  );
  const rows = result.rows as { ok: boolean; role: string; reason?: string }[];
  assert.equal(rows.length, 20);
  assert.equal(result.requests, 18);
  assert.deepEqual(
    rows
      .filter((row) => !row.ok)
      .map((row) => row.role)
      .sort(),
    ["PublicSite", "Router"],
  );
  assert.equal(rows.find((row) => row.role === "ArtifactsCredentials")!.ok, true);
  assert.match(rows.find((row) => row.role === "PublicSite")!.reason!, /missing-worker/);
  assert.match(rows.find((row) => row.role === "Router")!.reason!, /duplicate-worker/);
});
