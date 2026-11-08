import assert from "node:assert/strict";
import { test } from "node:test";
import { preparedUpload } from "./fixture.ts";
import { freezeUpload } from "./version-request.ts";
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
import { discoverScriptSettings } from "../architecture/native-stack.ts";

// Script settings return numeric target IDs; the exact active version resolves their meaning.
test("freezes Api placement from the live numeric settings shape and exact active version", async () => {
  const original = preparedUpload();
  const placement = { region: "aws:eu-central-1" };
  const input = {
    ...original,
    props: { placement },
    previousProps: { placement },
    previousSettings: { ...original.previousSettings },
  };
  input.request.metadata.placement = placement;
  input.request.metadata.limits = { subrequests: 50_000 };
  input.request.metadata.observability = {
    enabled: true,
    redactQueryString: true,
    logs: { enabled: true, invocationLogs: true, persist: true },
  };
  input.previousSettings = Schema.decodeUnknownSync(
    Workers.GetScriptScriptAndVersionSettingResponse,
  )({
    ...input.previousSettings,
    placement: { mode: "targeted", target: [39] },
    limits: { subrequests: 50_000 },
    observability: {
      enabled: true,
      headSamplingRate: 1,
      redactQueryString: true,
      logs: { enabled: true, headSamplingRate: 1, persist: true, invocationLogs: true },
      traces: { enabled: false, persist: true, headSamplingRate: 1 },
    },
    logpush: false,
    tailConsumers: [],
  });
  const baseline = [{ versionId: "active", percentage: 100 }];
  await assert.doesNotReject(() =>
    freezeUpload(input, baseline, [
      {
        id: "active",
        placement: {
          mode: "targeted",
          target: [{ id: 39, region: "aws:eu-central-1", type: "region" }],
        },
      },
    ]),
  );
});

test("all 19 real declarations project settings without planning, applying or accessing native state", () => {
  const declarations = discoverScriptSettings(process.cwd());
  assert.ok(Array.isArray(declarations));
  assert.equal(declarations.length, 19);
  for (const row of declarations) {
    assert.equal(typeof row.role, "string");
    assert.ok(row.metadata.tags.includes(`alchemy:id:${row.role}`));
  }
});
