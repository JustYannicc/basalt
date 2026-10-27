// Shared fixtures for carried-patch classification tests.
import assert from "node:assert/strict";
import { classifySnapshots } from "./classify.ts";
import { pins, sha } from "./fixtures.test-helpers.ts";
import { sha256PatchContent } from "./patch-registry.ts";
import type { ClassificationReport, PatchManifestV3 } from "./types.ts";

const file = "0011-hosted-connectors.patch";

/** Classifies one registered carry whose content changes from `before` to `after`. */
export function classifyCarry(
  before: string | Uint8Array | undefined,
  after: string | Uint8Array | undefined,
  sensitive = { database: false, workflow: false },
): ClassificationReport {
  const manifest = (content: string | Uint8Array | undefined): PatchManifestV3 => ({
    format_version: 3,
    repository: "UsefulSoftwareCo/executor",
    patches: content === undefined ? [] : [{
      identity: "basalt-hosted-connectors",
      file,
      content_sha256: sha256PatchContent(content),
      kind: "overlay",
      upstream_pull_request: null,
      database_sensitive: sensitive.database,
      workflow_sensitive: sensitive.workflow,
    }],
  });
  return classifySnapshots({
    baseGitCommit: sha("1"),
    candidateGitCommit: sha("2"),
    basePins: pins(),
    candidatePins: pins(),
    basePatchManifest: manifest(before),
    candidatePatchManifest: manifest(after),
    localChangedPaths: [`patches/${file}`],
    patchContents: { [file]: { base: before, candidate: after } },
  });
}

export const connectorSection = `diff --git a/apps/hosted/server/src/implementation/first-party-oauth.ts b/apps/hosted/server/src/implementation/first-party-oauth.ts
--- a/apps/hosted/server/src/implementation/first-party-oauth.ts
+++ b/apps/hosted/server/src/implementation/first-party-oauth.ts
@@ -114,6 +114,8 @@
   "search:confluence",
 ];

+/** The scopes the hosted Zendesk client may request and keep on a grant. */
+const zendeskScopes = ["tickets:read", "tickets:write", "users:read"];
 export const firstPartyClients = [
   atlassian,
   github,
`;

// The real carry change behind the User-Agent fix: a header added inside the outbound Worker.
export const outboundSection = `diff --git a/apps/hosted/cloud/src/infrastructure/app-outbound.ts b/apps/hosted/cloud/src/infrastructure/app-outbound.ts
--- a/apps/hosted/cloud/src/infrastructure/app-outbound.ts
+++ b/apps/hosted/cloud/src/infrastructure/app-outbound.ts
@@ -22,7 +22,14 @@
     compatibility: { date: "2026-09-08", flags: ["global_fetch_strictly_public"] },
     // This private service has no application bindings or credentials.
     script: \`export default {
-      fetch(request) { return fetch(request); }
+      fetch(request) {
+        if (!request.headers.has("User-Agent")) {
+          const headers = new Headers(request.headers);
+          headers.set("User-Agent", "Executor");
+          request = new Request(request, { headers });
+        }
+        return fetch(request);
+      }
     };\`,
   });
 });
`;

/** A modification section for `path` replacing `removed` lines with `added` lines. */
export function section(path: string, context: string[], removed: string[], added: string[], trailing: string[] = []): string {
  const oldCount = context.length + removed.length + trailing.length;
  const newCount = context.length + added.length + trailing.length;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -40,${oldCount} +40,${newCount} @@`,
    ...context.map((line) => ` ${line}`),
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    ...trailing.map((line) => ` ${line}`),
    "",
  ].join("\n");
}

/** A section that adds `lines` to `path` as new content. */
export function addition(path: string, lines: string[], after = 40): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${after},0 +${after + 1},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/** The carried-patch evidence states, `none` when the carry left that area clear. */
export function states(report: ClassificationReport): { database: string; workflow: string } {
  return {
    database: report.evidence.database.sources.find(({ name }) => name === "carried patches")?.state ?? "none",
    workflow: report.evidence.workflow.sources.find(({ name }) => name === "carried patches")?.state ?? "none",
  };
}

export function assertClear(report: ClassificationReport) {
  assert.equal(report.databaseChanged, false, JSON.stringify(report.evidence.database));
  assert.equal(report.workflowChanged, false, JSON.stringify(report.evidence.workflow));
}

// The EU carry edits a dependency patch; its inner `diff --git` headers are carry context lines.
export function nestedCarry(innerPath: string, removed: string[], added: string[], header = true, patch?: string): string {
  const inner = [
    ...header ? [
      ` diff --git a/${innerPath} b/${innerPath}`,
      " index a9ec2cb..edf8dcb 100644",
      ` --- a/${innerPath}`,
      ` +++ b/${innerPath}`,
    ] : [],
    " @@ -8,4 +8,5 @@ import * as Effect from \"effect/Effect\";",
    "  // Type the import before chaining to avoid expanding the full module namespace",
    ...removed.map((line) => `-+${line}`),
    ...added.map((line) => `++${line}`),
  ];
  return nestedPatch(inner, patch);
}

/** The carry section editing alchemy's dependency patch with `outer` (carry-prefixed) lines. */
export function nestedPatch(outer: string[], patch = "alchemy@2.0.0-beta.80.patch"): string {
  const oldCount = outer.filter((line) => !line.startsWith("+")).length;
  const newCount = outer.filter((line) => !line.startsWith("-")).length;
  return [
    `diff --git a/patches/${patch} b/patches/${patch}`,
    `--- a/patches/${patch}`,
    `+++ b/patches/${patch}`,
    `@@ -456,${oldCount} +2848,${newCount} @@ index 1d27a07..553a8c5 100644`,
    ...outer,
    "",
  ].join("\n");
}
