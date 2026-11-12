import assert from "node:assert/strict";
import { test } from "node:test";
import {
  claudeCollectionDiagnostic,
  sourceClaudeDiagnostic,
} from "./claude-collection-diagnostic.ts";
import { collectionDiagnostic, retainCollectionDiagnostic } from "./collection-diagnostic.ts";
import { object } from "./json.ts";

const source = {
  limits_present: true,
  grants_present: true,
  truncated: false,
  limits: [
    {
      kind: "weekly_scoped",
      model: "Fable",
      percent: 75,
      resets_at: "2026-11-14T12:00:00Z",
      token: "secret-sentinel",
    },
  ],
  grants: [
    {
      type: "weekly",
      remaining: 3,
      clears: ["seven_day_overage_included"],
      gives_back_weekly: true,
      ends_at: "2027-03-09T07:59:00Z",
      paused: false,
      id: "grant-secret",
      email: "private@example.invalid",
    },
  ],
  token: "secret-sentinel",
};
const diagnostic = {
  attempted_at: "2026-11-12T09:00:00Z",
  provider: "claude",
  response_received: true,
  json_valid: true,
  five_hour: {
    present: true,
    null: true,
    quantity_null: false,
    quantity_valid: false,
    five_hour: false,
  },
  claude: source,
};

test("closed Claude discovery shape survives retained detail reads without private source fields", async () => {
  const value = claudeCollectionDiagnostic(source)!;
  assert.equal(value.limits[0]?.model, "Fable");
  assert.equal(value.grants[0]?.remaining, 3);
  assert.equal(value.grants[0]?.givesBackWeekly, true);
  assert.equal(value.grants[0]?.endsAt, "2027-03-09T07:59:00.000Z");
  const data = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
  };
  const detail = {
    credential: { credential_id: "synthetic", provider: "claude" },
    collection: { diagnostic },
  };
  await retainCollectionDiagnostic(detail, "synthetic", storage);
  const retained = await retainCollectionDiagnostic(
    { credential: detail.credential },
    "synthetic",
    storage,
  );
  const projected = collectionDiagnostic(
    object(retained.collection) ? retained.collection.diagnostic : undefined,
    "claude",
  );
  assert.deepEqual(projected?.claude, value);
  assert.deepEqual(claudeCollectionDiagnostic(sourceClaudeDiagnostic(value)), value);
  for (const output of [value, ...data.values(), retained]) {
    assert.ok(!JSON.stringify(output).includes("secret"));
    assert.ok(!JSON.stringify(output).includes("private@"));
  }
});

test("discovery rejects unbounded rows and invalid names without dropping legacy flags", () => {
  assert.equal(
    claudeCollectionDiagnostic({ ...source, limits: Array(33).fill(source.limits[0]) }),
    undefined,
  );
  assert.equal(
    claudeCollectionDiagnostic({
      ...source,
      grants: [{ ...source.grants[0], clears: Array(17).fill("five_hour") }],
    }),
    undefined,
  );
  assert.equal(
    claudeCollectionDiagnostic({ ...source, limits: [{ kind: "private@example.invalid" }] }),
    undefined,
  );
  const retained = collectionDiagnostic(
    { ...diagnostic, claude: { ...source, limits: [] } },
    "claude",
  );
  assert.equal(retained?.fiveHour?.null, true);
  assert.equal(
    collectionDiagnostic({ ...diagnostic, claude: undefined }, "claude")?.claude,
    undefined,
    "the default-off collector adds no extended diagnostic",
  );
});
