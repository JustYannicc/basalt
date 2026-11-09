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

test("the real current candidate projects retirement status for all Worker roles", () => {
  const result = discoverCandidateSettings(process.cwd(), "retirement-ready");
  assert.ok(typeof result === "object" && result !== null && "ok" in result);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok("retirementRows" in result);
  assert.equal(result.retirementRows, 20);
});

for (const mode of ["entry-retirement-v7", "entry-retirement-v8"] as const)
  test(`the real entrypoint admits both exact damaged deployments through ${mode} retirement State GETs`, () => {
    const result = discoverCandidateSettings(process.cwd(), mode);
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "rows" in result &&
        "stateRequests" in result &&
        "priorReads" in result,
    );
    const rows = result.rows as {
      role: string;
      ok: boolean;
      compared: string[];
      settings: { status: number };
      placements: { status: number };
      pendingPlacementRepair?: { limits?: unknown };
    }[];
    assert.equal(rows.length, 20);
    assert.ok(
      rows.every((row) => row.ok),
      JSON.stringify(result),
    );
    assert.ok(rows.every((row) => row.compared.length === 8));
    assert.ok(rows.every((row) => row.settings.status === 200 && row.placements.status === 200));
    const repairs = rows.filter((row) => row.pendingPlacementRepair);
    assert.deepEqual(repairs.map((row) => row.role).sort(), ["Api", "AppPages"]);
    assert.deepEqual(repairs.find((row) => row.role === "Api")?.pendingPlacementRepair?.limits, {
      subrequests: { before: null, after: 50000 },
    });
    assert.equal(result.priorReads, 2);
    const requests = result.stateRequests as { method: string; path: string }[];
    assert.ok(requests.every((request) => request.method === "GET"));
    assert.equal(requests.filter((request) => request.path.endsWith("/output")).length, 1);
    assert.deepEqual(
      requests.map((request) => request.path),
      [
        "/version",
        "/version",
        "/state/stacks/basalt-placement-repair/stages/production/resources",
        "/state/stacks/basalt-placement-repair/stages/production/output",
      ],
    );
  });

for (const [mode, expected] of [
  ["entry-retirement-unauthorized", "retirement-state; status=401"],
  ["entry-retirement-malformed", "retirement-output"],
] as const)
  test(`the real entrypoint preserves safe ${mode} diagnostics for both repair roles`, () => {
    const result = discoverCandidateSettings(process.cwd(), mode);
    assert.ok(
      typeof result === "object" &&
        result !== null &&
        "rows" in result &&
        "stateRequests" in result &&
        "errors" in result,
    );
    const rows = result.rows as { role: string; ok: boolean; reason?: string }[];
    assert.equal(rows.filter((row) => row.ok).length, 18, JSON.stringify(result));
    for (const row of rows.filter((row) => !row.ok)) {
      assert.ok(["Api", "AppPages"].includes(row.role));
      assert.ok(row.reason?.includes(expected), JSON.stringify(row));
    }
    assert.doesNotMatch(
      JSON.stringify(result),
      /private-fixture-token|synthetic-state-token|state\.fixture/,
    );
    assert.ok(
      (result.stateRequests as { method: string }[]).every((request) => request.method === "GET"),
    );
  });

test("an unreviewed State version refuses before resource or output reads", () => {
  const result = discoverCandidateSettings(process.cwd(), "retirement-future");
  assert.deepEqual(result, {
    ok: false,
    failure: {
      tag: "CandidateSettingsReadFailure",
      causeTag: "StateStoreError",
      stage: "retirement-version",
      reason: "retirement-state-version-unsupported",
      observedVersion: 9,
    },
    stateRequests: [{ method: "GET", path: "/version" }],
  });
});

test("State and auth diagnostics retain only bounded HTTP and version numbers", () => {
  for (const [error, stage, expected] of [
    [
      { _tag: "StateStoreError", http: { status: 401 }, message: "private-fixture-token" },
      "retirement-state",
      { status: 401 },
    ],
    [
      Object.assign(
        new Error(
          "Cloudflare State store is out of date (expected v8, observed v7). private-fixture-token",
        ),
        { _tag: "AuthError" },
      ),
      "retirement-auth",
      { expectedVersion: 8, observedVersion: 7 },
    ],
  ] as const) {
    const safe = candidateReadFailure(error, stage);
    assert.deepEqual(candidateFailureDetails(safe), {
      tag: "CandidateSettingsReadFailure",
      causeTag: error._tag,
      stage,
      ...expected,
    });
    assert.doesNotMatch(safe.message, /private-fixture-token/);
  }
});
