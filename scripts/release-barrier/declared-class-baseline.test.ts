import assert from "node:assert/strict";
import { test } from "node:test";
import type * as Workers from "@distilled.cloud/cloudflare/workers";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";
import { declaredClassBaseline } from "./declared-class-contract.ts";
import { assertScriptSettings } from "./script-settings.ts";

const script = "basalt-artifactscredentials-fixture";
const coordinator = {
  type: "durable_object_namespace",
  name: "ArtifactsTokenCoordinator",
  className: "ArtifactsTokenCoordinator",
  namespaceId: "namespace-coordinator",
} as const;
const entry = decodeDeclaredChanges({
  schemaVersion: 1,
  stack: "basalt",
  retentionOwner: "Basalt deployment",
  changes: [
    {
      action: "add-sqlite-class",
      type: "Cloudflare.Worker",
      fqn: "ArtifactsCredentials",
      newSqliteClasses: ["VaultDrive"],
      addedBindings: [
        {
          type: "durable_object_namespace",
          name: "VaultDrive",
          className: "VaultDrive",
          location: "local",
        },
      ],
      retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
    },
  ],
}).changes[0] as Parameters<typeof declaredClassBaseline>[3];
const live = {
  bindings: [coordinator],
  tags: ["alchemy:stack:basalt", "alchemy:dos:ArtifactsTokenCoordinator=ArtifactsTokenCoordinator"],
  logpush: false,
  tail_consumers: [],
} as unknown as Workers.GetScriptScriptAndVersionSettingResponse;
const candidate = (overrides: Partial<Workers.PutScriptMetadata> = {}) =>
  ({
    bindings: [
      {
        type: "durable_object_namespace",
        name: "ArtifactsTokenCoordinator",
        className: "ArtifactsTokenCoordinator",
      },
      { type: "durable_object_namespace", name: "VaultDrive", className: "VaultDrive" },
    ],
    tags: [
      "alchemy:stack:basalt",
      "alchemy:dos:ArtifactsTokenCoordinator=ArtifactsTokenCoordinator;VaultDrive=VaultDrive",
    ],
    ...overrides,
  }) as Workers.PutScriptMetadata;

test("a declared class is compared against live settings as its expansion will leave them", () => {
  // Unprojected, this is the refusal the probe used to report before any expansion ran.
  assert.throws(
    () => assertScriptSettings("ArtifactsCredentials", script, candidate(), live),
    (error: Error) => error.message.includes("durable-object-class-drift"),
  );
  const projected = declaredClassBaseline(live, candidate(), script, entry);
  assert.doesNotThrow(() =>
    assertScriptSettings("ArtifactsCredentials", script, candidate(), projected),
  );
});

test("an expansion that is already live compares as is", () => {
  const expanded = {
    ...live,
    bindings: [
      ...(live.bindings ?? []),
      { type: "durable_object_namespace", name: "VaultDrive", className: "VaultDrive" },
    ],
  } as Workers.GetScriptScriptAndVersionSettingResponse;
  assert.equal(declaredClassBaseline(expanded, candidate(), script, entry), expanded);
});

test("anything beyond the declared class delta still refuses", () => {
  const extra = candidate({
    bindings: [
      ...(candidate().bindings ?? []),
      { type: "durable_object_namespace", name: "Undeclared", className: "Undeclared" },
    ] as Workers.PutScriptMetadata["bindings"],
  });
  assert.throws(
    () => declaredClassBaseline(live, extra, script, entry),
    /declared-class-binding-mismatch/,
  );
  const retagged = candidate({ tags: [...(candidate().tags ?? []), "alchemy:stage:other"] });
  assert.throws(
    () => declaredClassBaseline(live, retagged, script, entry),
    /declared-class-tags-mismatch/,
  );
});
