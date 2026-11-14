import { test } from "node:test";
import assert from "node:assert/strict";
import { Schema } from "effect";
import {
  DeviceRequestView,
  deviceReport,
  deviceReportLabel,
  deviceReportLimit,
} from "../../.upstream/packages/mcp-auth/src/contracts/device.ts";

test("a device-reported label keeps only what can be shown as plain text, capped", () => {
  assert.equal(deviceReportLabel(undefined), undefined);
  assert.equal(deviceReportLabel(" \u0000​\n "), undefined);
  // Control, bidi-override and line-separator characters can't rearrange or break the page.
  assert.equal(deviceReportLabel("Studio‮ Mac mini\t"), "Studio Mac mini");
  // Markup stays text; the page renders it escaped.
  assert.equal(deviceReportLabel("<b>Personal</b>"), "<b>Personal</b>");
  assert.equal(deviceReportLabel("Notes 🗒️ ✦"), "Notes 🗒️ ✦");
  const long = deviceReportLabel("é".repeat(200));
  assert.equal(Array.from(long ?? "").length, deviceReportLimit);
});

test("a request from an older device reports nothing and is reviewed exactly as before", () => {
  // The form an older plugin sends: no labels, so nothing is stored or shown for them.
  assert.equal(deviceReport({}), undefined);
  assert.equal(deviceReport({ device_name: " ", device_context: "\u0000" }), undefined);
  assert.deepEqual(deviceReport({ device_name: "Alex MacBook Pro", device_context: "Personal" }), {
    name: "Alex MacBook Pro",
    context: "Personal",
  });
  const old = { clientId: "public-device", resource: "https://fixture.invalid/mcp", scopes: [] };
  assert.deepEqual(Schema.decodeUnknownSync(DeviceRequestView)(old), old);
});
