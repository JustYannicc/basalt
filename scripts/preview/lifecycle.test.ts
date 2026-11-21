import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { requiredPreviewDeploySecrets } from "../environment.ts";
import type { LifecycleServices } from "./lifecycle.ts";
import {
  deployPreview,
  destroyStage,
  planPreview,
  planStage,
  verifyStageAbsent,
} from "./lifecycle.ts";
import { manifestPath } from "../release-preview/checkpoint.ts";
import { readPreviewManifest, updatePreviewManifest } from "./manifest.ts";

const originalBrand = `export const brand = {
  host: "app.production.example.invalid",
  zone: "production.example.invalid",
} as const;
`;

function environment(): NodeJS.ProcessEnv {
  const source = Object.fromEntries(
    requiredPreviewDeploySecrets.map((name) => [name, "fixture"]),
  ) as NodeJS.ProcessEnv;
  Object.assign(source, {
    GITHUB_ACTIONS: "true",
    PREVIEW_MANIFEST_CHECKPOINTED: "1",
    TEST_STAGE_DOMAIN: "preview.example.invalid",
    PREVIEW_STATE_KEY: "17".repeat(32),
    PREVIEW_SMOKE_EMAIL: "preview-pr-17@example.invalid",
    PREVIEW_SMOKE_PASSWORD: "fixture-preview-password-that-is-long-enough",
  });
  return source;
}

function services(root: string, observations: string[], failDeploy = false): LifecycleServices {
  return {
    stateReader: () => ({ read: async () => ({ basalt: [], "basalt-preview-database": [] }) }),
    captureProviders: async () => ({ complete: true, containers: [], domains: [] }),
    build: async (buildRoot) => {
      const source = await readFile(join(buildRoot, "brand.ts"), "utf8");
      observations.push("build:" + source);
    },
    deploy: async (identity, _environment, seedFile) => {
      const source = await readFile(join(root, "brand.ts"), "utf8");
      observations.push("deploy:" + source);
      if (failDeploy) throw new Error("fixture deployment failed");
      await writeFile(
        seedFile,
        `${JSON.stringify({
          version: 1,
          stage: identity.stage,
          origin: identity.origin,
          userId: "preview-user-17",
          organization: { id: "organization-17", slug: "preview-smoke-17" },
          poolAppId: "pool-app-17",
        })}\n`,
        { flag: "wx", mode: 0o600 },
      );
    },
    destroyStack: async () => {},
    deleteArtifacts: async () => {},
    verifyProviders: async () => {},
    stageApplications: async () => {},
    stageImages: async () => {},
    stageOutputs: async () => {},
  };
}

test("the preview host stays materialized through build and both deploy stacks, then restores", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-lifecycle-"));
  const source = environment();
  const observations: string[] = [];
  try {
    await writeFile(join(root, "brand.ts"), originalBrand, { mode: 0o600 });
    await planPreview(root, 17, source);
    await deployPreview(root, 17, source, services(root, observations));
    assert.equal(observations.length, 2);
    for (const observation of observations) {
      assert.match(observation, /host: "app\.pr-17\.preview\.example\.invalid"/);
      assert.match(observation, /zone: "preview\.example\.invalid"/);
    }
    assert.equal(await readFile(join(root, "brand.ts"), "utf8"), originalBrand);
    const manifest = await readPreviewManifest(manifestPath(root, 17), 17);
    assert.equal(manifest.phase, "seeded");
    assert.equal(manifest.organizationId, "organization-17");
    assert.equal(manifest.poolAppId, "pool-app-17");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed deploy restores the tracked brand source", async () => {
  const root = await mkdtemp(join(tmpdir(), "preview-lifecycle-fail-"));
  const source = environment();
  try {
    await writeFile(join(root, "brand.ts"), originalBrand, { mode: 0o600 });
    await planPreview(root, 17, source);
    await assert.rejects(
      deployPreview(root, 17, source, services(root, [], true)),
      /fixture deployment failed/,
    );
    assert.equal(await readFile(join(root, "brand.ts"), "utf8"), originalBrand);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a rehearsal deploys only its database parent, then destroys and verifies its own stage", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-lifecycle-"));
  const source = environment();
  const subject = { kind: "rehearsal", number: 17 } as const;
  const calls: string[] = [];
  const row = (stack: string, fqn: string) => ({
    path: `${stack}/test-rehearsal-17/${fqn}`,
    value: { resourceType: "Cloudflare.Worker", attr: { workerName: fqn } },
  });
  let deployed = false;
  const live: LifecycleServices = {
    stateReader: (environment) => ({
      read: async (stage) => {
        assert.equal(stage, "test-rehearsal-17");
        assert.equal(environment.ALCHEMY_STAGE, "test-rehearsal-17");
        return deployed
          ? {
              "basalt-rehearsal": [row("basalt-rehearsal", "Router")],
              "basalt-preview-database": [],
              "basalt-rehearsal-fixture": [],
            }
          : {
              "basalt-rehearsal": [],
              "basalt-preview-database": [],
              "basalt-rehearsal-fixture": [],
            };
      },
    }),
    captureProviders: async () => ({ complete: true, containers: [], domains: [] }),
    build: async () => assert.fail("a rehearsal database deploy builds nothing"),
    deploy: async () => assert.fail("this test never deploys the application"),
    destroyStack: async (stack, identity, environment) => {
      calls.push(`destroy:${stack}:${identity.stage}:${environment.ALCHEMY_STAGE}`);
    },
    deleteArtifacts: async (namespace) => {
      calls.push(`artifacts:${namespace}`);
      deployed = false;
    },
    verifyProviders: async (identity) => {
      calls.push(`verify:${identity.stage}`);
    },
    stageApplications: async (mode, identity) => {
      calls.push(`applications:${mode}:${identity.stage}`);
    },
    stageImages: async (mode, identity) => {
      calls.push(`images:${mode}:${identity.stage}`);
    },
    stageOutputs: async (mode, identity) => {
      calls.push(`outputs:${mode}:${identity.stage}`);
    },
  };
  try {
    const planned = await planStage(root, subject, source);
    assert.equal(planned.rehearsal, 17);
    assert.equal(planned.stage, "test-rehearsal-17");
    assert.equal(
      manifestPath(root, subject),
      join(root, ".local", "previews", "rehearsal-17.json"),
    );
    await assert.rejects(
      readPreviewManifest(manifestPath(root, subject), 17),
      /identity or phase is invalid/,
    );
    // A rehearsal's releases deploy the stage; destroy must find it from the deploying checkpoint alone.
    await updatePreviewManifest(manifestPath(root, subject), subject, "deploying");
    deployed = true;
    await destroyStage(root, subject, source, live);
    await verifyStageAbsent(root, subject, source, live);
    assert.deepEqual(calls, [
      "destroy:basalt:test-rehearsal-17:test-rehearsal-17",
      "applications:delete:test-rehearsal-17",
      "images:delete:test-rehearsal-17",
      "destroy:database:test-rehearsal-17:test-rehearsal-17",
      "artifacts:basalt-preview-rehearsal-17-apps",
      "outputs:delete:test-rehearsal-17",
      "verify:test-rehearsal-17",
      "applications:verify:test-rehearsal-17",
      "images:verify:test-rehearsal-17",
      "outputs:verify:test-rehearsal-17",
    ]);
    await assert.rejects(readFile(manifestPath(root, subject)), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a PR manifest never reads back as a rehearsal of the same number", async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-lifecycle-cross-"));
  const source = environment();
  try {
    await planPreview(root, 17, source);
    await writeFile(
      manifestPath(root, { kind: "rehearsal", number: 17 }),
      await readFile(manifestPath(root, 17)),
    );
    await assert.rejects(
      readPreviewManifest(manifestPath(root, { kind: "rehearsal", number: 17 }), {
        kind: "rehearsal",
        number: 17,
      }),
      /identity or phase is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the stage brand replaces only the brand object's host and zone in the real brand file", async () => {
  const { previewBrandSource } = await import("./lifecycle.ts");
  const { appHosting, brand } = await import("../../brand.ts");
  const real = await readFile(new URL("../../brand.ts", import.meta.url), "utf8");
  const changed = previewBrandSource(
    real,
    "app.rehearsal-1.preview.example.invalid",
    "preview.example.invalid",
  );
  const before = real.split("\n");
  const after = changed.split("\n");
  assert.equal(after.length, before.length);
  const edits = before.flatMap((line, index) =>
    line === after[index] ? [] : [[line, after[index]]],
  );
  assert.deepEqual(edits, [
    [
      `  host: ${JSON.stringify(brand.host)},`,
      '  host: "app.rehearsal-1.preview.example.invalid",',
    ],
    [`  zone: ${JSON.stringify(brand.zone)},`, '  zone: "preview.example.invalid",'],
  ]);
  // appHosting keeps production's own zone line.
  assert.ok(
    after
      .slice(after.indexOf("export const appHosting = {"))
      .includes(`  zone: ${JSON.stringify(appHosting.zone)},`),
  );
  assert.throws(
    () =>
      previewBrandSource(
        real.replace("export const brand = {", "export const label = {"),
        "a",
        "b",
      ),
    /seam changed/,
  );
});

/** A rehearsal stage's destroy, with the fixture stack's State as the reader returns it. */
async function rehearsalDestroy(fixture: "none" | "one" | "output" | "unread", failing?: string) {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-fixture-"));
  const source = environment();
  const subject = { kind: "rehearsal", number: 17 } as const;
  const calls: string[] = [];
  const row = (stack: string, fqn: string) => ({
    path: `${stack}/test-rehearsal-17/${fqn}`,
    value: { resourceType: "Cloudflare.Worker", attr: { workerName: fqn } },
  });
  const record = (name: string) => async () => void calls.push(name);
  const live: LifecycleServices = {
    stateReader: () => ({
      read: async () => ({
        "basalt-rehearsal": [row("basalt-rehearsal", "Router")],
        "basalt-preview-database": [],
        ...(fixture === "unread"
          ? {}
          : {
              "basalt-rehearsal-fixture":
                fixture === "one"
                  ? [row("basalt-rehearsal-fixture", "SeedAccount")]
                  : fixture === "output"
                    ? [{ path: "basalt-rehearsal-fixture/test-rehearsal-17/output", value: {} }]
                    : [],
            }),
      }),
    }),
    captureProviders: async () => ({ complete: true, containers: [], domains: [] }),
    build: async () => assert.fail("no build"),
    deploy: async () => assert.fail("no deploy"),
    destroyStack: async (stack) => {
      calls.push(`destroy:${stack}`);
      if (stack === failing) throw new Error(`${stack} refused`);
    },
    deleteArtifacts: record("artifacts"),
    verifyProviders: record("verify"),
    stageApplications: async (mode) => {
      calls.push(`applications:${mode}`);
      if (failing === "applications") throw new Error("applications refused");
    },
    stageImages: async (mode) => void calls.push(`images:${mode}`),
    stageOutputs: async (mode) => void calls.push(`outputs:${mode}`),
  };
  try {
    await planStage(root, subject, source);
    await updatePreviewManifest(manifestPath(root, subject), subject, "deploying");
    const outcome = await destroyStage(root, subject, source, live).then(
      () => undefined,
      (error: unknown) => error,
    );
    return { calls, outcome };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("(a) a rehearsal stage with no fixture State skips the fixture step, and the next step runs", async () => {
  const { calls, outcome } = await rehearsalDestroy("none");
  assert.equal(outcome, undefined);
  assert.ok(!calls.includes("destroy:fixture"));
  assert.equal(calls[0], "destroy:basalt");
});

test("(b) a rehearsal stage with fixture State refuses before any delete", async () => {
  const { calls, outcome } = await rehearsalDestroy("one");
  assert.match(String(outcome), /fixture stack holds State/u);
  assert.deepEqual(calls, []);
});

test("(b2) a fixture stack holding only its output row refuses too: any fixture row refuses", async () => {
  const { calls, outcome } = await rehearsalDestroy("output");
  assert.match(String(outcome), /fixture stack holds State/u);
  assert.deepEqual(calls, []);
});

test("(c) a fixture stack the read did not return refuses: a failed read is never no rows", async () => {
  const { calls, outcome } = await rehearsalDestroy("unread");
  // The inventory's exact-keys check refuses first; the destroy's own guard is the second line.
  assert.match(
    String(outcome),
    /fixture stack's State was not read|Preview state response has unexpected fields/u,
  );
  assert.deepEqual(calls, []);
});

test("a rehearsal whose application stack refuses still removes its paid parts, then stops and says so", async () => {
  const { calls, outcome } = await rehearsalDestroy("none", "basalt");
  assert.ok(outcome instanceof AggregateError);
  assert.match(String((outcome.errors[0] as Error).message), /basalt cleanup failed/u);
  // Only the container applications and the database go after the failure; images, artifacts and
  // outputs wait for the next attempt.
  assert.deepEqual(calls, ["destroy:basalt", "applications:delete", "destroy:database"]);
});

test("a rehearsal whose applications delete refuses still removes its database", async () => {
  const { calls, outcome } = await rehearsalDestroy("none", "applications");
  assert.ok(outcome instanceof AggregateError);
  assert.deepEqual(calls, ["destroy:basalt", "applications:delete", "destroy:database"]);
});
