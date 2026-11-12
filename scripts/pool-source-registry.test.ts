import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { readPatchManifest } from "./releases/patches.ts";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

test("pool carries bind the exact source, patch bytes and manual retirement proof", () => {
  const registry = readPatchManifest(fileURLToPath(root));
  assert.ok(registry.pool_carries);
  const bytes = read(registry.pool_carries.manifest);
  assert.equal(digest(bytes), registry.pool_carries.content_sha256);
  const sources = JSON.parse(bytes.toString());
  const releases = JSON.parse(read("containers/pool/releases.json").toString());
  const files: string[] = [];
  for (const name of ["home", "node"]) {
    const artifact = sources.artifacts[name],
      release = releases.artifacts[name];
    assert.equal(artifact.commit, release.commit);
    assert.equal(artifact.repository, release.repository);
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    for (const patch of artifact.patches) {
      assert.match(patch.identity, /^[a-z][a-z0-9-]+$/);
      assert.match(patch.file, /^[a-zA-Z0-9_.-]+\.patch$/);
      assert.equal(digest(read(`containers/pool/patches/${patch.file}`)), patch.sha256);
      assert.equal(patch.retirement.mode, "manual");
      if (patch.identity === "cliproxy-home-single-line-log-records") {
        assert.equal(name, "home");
        assert.match(
          patch.retirement.requires,
          /escapes embedded CR and LF after formatting all log fields/,
        );
        assert.match(patch.retirement.requires, /exactly one physical line per record/);
        assert.match(
          patch.retirement.requires,
          /formatter and real-child snapshot\/exit-receipt injection regressions/,
        );
        assert.match(patch.retirement.requires, /without changing request handling/);
      } else if (patch.identity === "cliproxy-home-conditional-deletion") {
        assert.equal(name, "home");
        assert.match(
          patch.retirement.requires,
          /conditional credential and membership deletion routes/,
        );
        assert.match(
          patch.retirement.requires,
          /approved PostgreSQL full-row checksum under the mutation lock/,
        );
        assert.match(patch.retirement.requires, /refuse stale rows without deletion/);
        assert.match(
          patch.retirement.requires,
          /refresh-race and unchanged-row deletion regressions/,
        );
      } else if (patch.identity === "cliproxy-home-bounded-db-pool") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0284-home-db-pool.patch");
        assert.match(patch.retirement.requires, /validated connection limits/);
        assert.match(patch.retirement.requires, /config apply and liveness/);
        assert.match(patch.retirement.requires, /direct transport and advisory locks/);
        assert.match(patch.retirement.requires, /pool wait counters/);
      } else if (patch.identity === "cliproxy-home-transaction-schema-owner") {
        assert.equal(name, "home");
        assert.match(patch.retirement.requires, /stable schema owner/);
        assert.match(patch.retirement.requires, /commit and rollback/);
        assert.match(patch.retirement.requires, /multi-process shared-budget/);
      } else if (patch.identity === "cliproxy-home-quota-collection-signals") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0459-home-quota-collection-signals.patch");
        assert.match(patch.retirement.requires, /one bounded metadata-only record/);
        assert.match(
          patch.retirement.requires,
          /returned vendor window field paths and durations before parsing/,
        );
        assert.match(patch.retirement.requires, /actual collector, omitted and unusable window/);
        assert.match(patch.retirement.requires, /real-child container stdout/);
      } else if (patch.identity === "cliproxy-home-collection-field-presence") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0477-home-collection-field-presence.patch");
        assert.match(patch.retirement.requires, /independently of logs/);
        assert.match(patch.retirement.requires, /authenticated pool view/);
        assert.match(patch.retirement.requires, /without response bodies, amounts or credentials/);
      } else if (patch.identity === "cliproxy-home-xai-device") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0399-home-xai-device.patch");
        assert.match(patch.retirement.requires, /xAI device authorization/);
        assert.match(patch.retirement.requires, /keeps device secrets server-side/);
        assert.match(patch.retirement.requires, /provider expiry and cancellation/);
        assert.match(patch.retirement.requires, /atomic exact-ID completion receipt/);
        assert.match(
          patch.retirement.requires,
          /expiry, denial, pending, slow-down and cancellation regressions/,
        );
      } else if (patch.identity === "cliproxy-home-xai-quota-client-version") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0458-home-xai-quota-client-version.patch");
        assert.match(patch.retirement.requires, /supported Grok CLI client version/);
        assert.match(patch.retirement.requires, /both subscription billing reads/);
        assert.match(patch.retirement.requires, /HTTP 426 rejection/);
        assert.match(
          patch.retirement.requires,
          /unchanged credential, permission, rate-limit and outage classification/,
        );
      } else if (patch.identity === "cliproxy-home-xai-collection-diagnostic") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0490-home-xai-collection-diagnostic.patch");
        assert.match(
          patch.retirement.requires,
          /monthly and weekly source-field flags tied to collector invocation time/,
        );
        assert.match(
          patch.retirement.requires,
          /forced claim refusal and vendor completion persistence/,
        );
        assert.match(
          patch.retirement.requires,
          /field-shape, privacy, real-collector, lease-loss, write-failure and management-detail regressions/,
        );
        assert.match(
          patch.retirement.requires,
          /pool-owned persistence through the existing authenticated view/,
        );
        assert.match(patch.retirement.requires, /same-attempt completion ordering/);
        assert.match(patch.retirement.requires, /without response bodies, amounts or credentials/);
        assert.match(
          patch.retirement.requires,
          /without changing Home database models or versions/,
        );
      } else if (patch.identity === "cliproxy-home-xai-optional-quota-fields") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0497-home-xai-optional-quota-fields.patch");
        assert.match(
          patch.retirement.requires,
          /omitted weekly percentages and on-demand usage as not reported/,
        );
        assert.match(patch.retirement.requires, /never infers zero/);
        assert.match(patch.retirement.requires, /rejects present invalid optional values/);
        assert.match(
          patch.retirement.requires,
          /observed-shape, explicit-zero, alias, malformed-value, retained-window and real-collector regressions/,
        );
        assert.match(
          patch.retirement.requires,
          /without changing Home database models or versions/,
        );
      } else if (patch.identity === "cliproxy-home-xai-grok-pro-entitlement") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0511-home-xai-grok-pro-entitlement.patch");
        assert.match(patch.retirement.requires, /recognizes the GrokPro paid subscription tier/);
        assert.match(patch.retirement.requires, /numeric weekly and product percentages/);
        assert.match(
          patch.retirement.requires,
          /closed malformed, missing, ambiguous, non-string or unknown-tier/,
        );
        assert.match(patch.retirement.requires, /fixed field-type flags only/);
        assert.match(
          patch.retirement.requires,
          /real-collector, unknown-profile and free-profile regressions/,
        );
        assert.match(
          patch.retirement.requires,
          /without changing Home database models or versions/,
        );
      } else if (patch.identity === "cliproxy-home-xai-healthy-unmetered") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0500-home-xai-healthy-unmetered.patch");
        assert.match(patch.retirement.requires, /monthly and weekly quota omissions/);
        assert.match(patch.retirement.requires, /healthy unmetered collections/);
        assert.match(patch.retirement.requires, /present invalid values and real request errors/);
        assert.match(patch.retirement.requires, /authoritative omission replaces old measurements/);
        assert.match(
          patch.retirement.requires,
          /without changing Home database models or versions/,
        );
      } else if (patch.identity === "cliproxy-home-xai-subscription-quota") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0469-home-xai-subscription-quota.patch");
        assert.match(patch.retirement.requires, /remove when the pin moves to ≥ v1\.1\.8/);
        assert.match(patch.retirement.requires, /paid omitted-zero, free\/unknown-profile/);
        assert.match(patch.retirement.requires, /retained-window, supported-client/);
        assert.match(
          patch.retirement.requires,
          /metadata-only collection regressions pass on the new pin/,
        );
      } else if (
        patch.identity === "cliproxy-home-usage-credits" ||
        patch.identity === "cliproxy-node-usage-credit-routing"
      ) {
        assert.equal(
          patch.file,
          name === "home"
            ? "0506-home-usage-credits.patch"
            : "0507-node-usage-credit-routing.patch",
        );
        assert.match(
          patch.retirement.requires,
          /pool-owned policy and plan-before-affinity selection/,
        );
        assert.match(patch.retirement.requires, /never-policy and retained WebSocket turn proofs/);
        assert.match(
          patch.retirement.requires,
          /preserves existing schema rows through additive upgrades/,
        );
      } else if (
        patch.identity === "cliproxy-home-dispatch-timing" ||
        patch.identity === "cliproxy-node-dispatch-timing"
      ) {
        const home = patch.identity === "cliproxy-home-dispatch-timing";
        assert.equal(name, home ? "home" : "node");
        assert.equal(
          patch.file,
          home ? "0509-home-dispatch-timing.patch" : "0512-node-dispatch-timing.patch",
        );
        assert.match(patch.retirement.requires, /same closed stage timings/);
        assert.match(
          patch.retirement.requires,
          /success, failure, privacy, duration-bound and real-child projection regressions/,
        );
        assert.match(patch.retirement.requires, /without changing dispatch behavior/);
      } else if (
        patch.identity === "cliproxy-home-dispatch-timing-trailer" ||
        patch.identity === "cliproxy-node-dispatch-timing-header"
      ) {
        const home = patch.identity === "cliproxy-home-dispatch-timing-trailer";
        assert.equal(name, home ? "home" : "node");
        assert.equal(
          patch.file,
          home
            ? "0515-home-dispatch-timing-trailer.patch"
            : "0516-node-dispatch-timing-header.patch",
        );
        assert.match(patch.retirement.requires, /opt-in primary dispatch reply/);
        assert.match(patch.retirement.requires, /bounded closed timing transport/);
        assert.match(patch.retirement.requires, /failure fencing, legacy compatibility/);
        assert.match(
          patch.retirement.requires,
          /synthetic-provider response proof through Worker logs/,
        );
        assert.match(patch.retirement.requires, /without exposing diagnostic headers to clients/);
      } else if (patch.identity === "cliproxy-home-funding-read") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0519-home-funding-read.patch");
        assert.match(patch.retirement.requires, /one authoritative SQL statement/);
        assert.match(
          patch.retirement.requires,
          /old-result parity, soft deletion, expiry and missing-data semantics/,
        );
        assert.match(
          patch.retirement.requires,
          /PostgreSQL concurrent-update and query-budget proof/,
        );
        assert.match(
          patch.retirement.requires,
          /Admission and management loaders remain unchanged/,
        );
      } else if (patch.identity === "cliproxy-home-reset-aware-selection") {
        assert.equal(name, "home");
        assert.equal(patch.file, "0522-home-reset-aware-selection.patch");
        assert.match(patch.retirement.requires, /eligible sticky and parent sessions/);
        assert.match(patch.retirement.requires, /account-wide weekly reset/);
        assert.match(
          patch.retirement.requires,
          /model limits as eligibility gates and credits last/,
        );
        assert.match(patch.retirement.requires, /reversible per-pool balanced selection/);
        assert.match(patch.retirement.requires, /retained v14 data additively/);
        assert.match(
          patch.retirement.requires,
          /admission, privacy, policy and repeated-boot regressions/,
        );
      } else {
        assert.ok(
          patch.retirement.requires.includes("forced failure") &&
            patch.retirement.requires.includes("purge"),
        );
      }
      files.push(patch.file);
    }
  }
  assert.equal(new Set(files).size, files.length);
  assert.deepEqual(
    files.sort(),
    readdirSync(new URL("containers/pool/patches/", root))
      .filter((file) => file.endsWith(".patch"))
      .sort(),
  );
});
