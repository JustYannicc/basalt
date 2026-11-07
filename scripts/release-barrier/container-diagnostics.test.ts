import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";
import { releaseWorkers } from "./barrier.ts";
import { decodeApplication, waitForContainerVersion } from "./container-cloudflare.ts";
import { assertImageOnlyPublication } from "./container.ts";
import { BarrierRefusal } from "./manifest.ts";
import { reportRefusal, refusalTable } from "./refusal-report.ts";
import {
  containerProps,
  containerPublication,
  containerRelease,
} from "./test/container-fixture.ts";

async function publicOutput(error: unknown) {
  assert.ok(error instanceof BarrierRefusal);
  const directory = await mkdtemp(join(tmpdir(), "container-diagnostic-"));
  try {
    const messages: string[] = [];
    const summary = join(directory, "summary.md");
    await reportRefusal(error, summary, (message) => messages.push(message));
    return [messages.join("\n"), await readFile(summary, "utf8")];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("post-database baseline drift names the resource and exact change in error and summary", async () => {
  const proof = containerRelease();
  proof.options.beforeActivate = async () => {
    proof.setCurrent({ ...proof.current(), maxInstances: 2 });
  };
  const failure = await releaseWorkers(proof.manifest, proof.options).then(
    () => assert.fail("drift must refuse"),
    (error: unknown) => error,
  );
  for (const output of await publicOutput(failure)) {
    assert.match(output, /PoolContainer/);
    assert.match(output, /maxInstances.*1 → 2/);
  }
  assert.ok(!proof.events.some((event) => event.startsWith("activate:")));
});

test("unsupported raw settings retain every sanitized schema path without their values", async () => {
  let failure: unknown;
  try {
    decodeApplication({
      id: "pool-app",
      name: "pool",
      account_id: "fixture",
      version: 1,
      created_at: "2026-01-01T00:00:00Z",
      scheduling_policy: "default",
      instances: 1,
      max_instances: 1,
      configuration: {
        image: containerPublication().previous.configuration.image,
        authorized_keys: [{ public_key: "private-key-value" }],
        future_setting: "private-setting-value",
      },
    });
    assert.fail("unsupported settings must refuse");
  } catch (error) {
    failure = error;
  }
  for (const output of await publicOutput(failure)) {
    assert.match(output, /PoolContainer/);
    assert.match(output, /configuration.authorized_keys/);
    assert.match(output, /configuration.future_setting/);
    assert.ok(!output.includes("private-key-value"));
    assert.ok(!output.includes("private-setting-value"));
  }
});

test("rollout target configuration drift preserves its observed public delta", async () => {
  const proof = containerPublication();
  const exit = await Effect.runPromiseExit(
    waitForContainerVersion(
      { ...proof.frozen.baseline, configuration: proof.frozen.configuration },
      { id: "rollout", currentVersion: 1, targetVersion: 2 },
      () => Effect.succeed({ ...proof.proposed, version: 2, maxInstances: 2 }),
    ),
  );
  assert.ok(Exit.isFailure(exit));
  for (const output of await publicOutput(Cause.squash(exit.cause))) {
    assert.match(output, /PoolContainer/);
    assert.match(output, /maxInstances.*1 → 2/);
  }
});

test("an instances-only publication mismatch names the count the policy compares", () => {
  const proof = containerPublication();
  proof.proposed.instances = 2;
  assert.throws(
    () =>
      assertImageOnlyPublication(
        proof.publication,
        containerProps(),
        containerProps(),
        proof.previous,
      ),
    (error) => {
      assert.ok(error instanceof BarrierRefusal);
      assert.match(refusalTable(error), /instances.*1 → 2/);
      return true;
    },
  );
});

test("equivalent-digest verification refuses a foreign final readback before accepting native attributes", async () => {
  const proof = containerRelease();
  let reads = 0;
  const read = proof.options.containers.read;
  proof.options.containers.read = async (container) => {
    const current = await read(container);
    return ++reads === 3 ? { ...current, version: 99 } : current;
  };
  const failure = await releaseWorkers(
    {
      ...proof.manifest,
      containers: [
        {
          ...proof.frozen,
          configuration: proof.previous.configuration,
          imageDigest: proof.previous.hash!.digest!,
        },
      ],
    },
    proof.options,
  ).then(
    () => assert.fail("foreign final readback must refuse"),
    (error: unknown) => error,
  );
  for (const output of await publicOutput(failure)) assert.match(output, /version.*1 → 99/);
  assert.ok(!proof.events.includes("container:serving"));
  assert.ok(!proof.events.includes("container:rollout"));
});

for (const attachment of [
  { namespace_id: { value: "private-attachment-value" } },
  { namespace_id: "namespace", future_attachment: "private-attachment-value" },
])
  test("attachment schema diagnostics preserve their full application path", async () => {
    let failure: unknown;
    try {
      decodeApplication({
        id: "pool-app",
        name: "pool",
        account_id: "fixture",
        version: 1,
        created_at: "2026-01-01T00:00:00Z",
        scheduling_policy: "default",
        instances: 1,
        max_instances: 1,
        configuration: { image: containerPublication().previous.configuration.image },
        durable_objects: attachment,
      });
      assert.fail("unsupported attachment must refuse");
    } catch (error) {
      failure = error;
    }
    for (const output of await publicOutput(failure)) {
      assert.match(output, /durable_objects\.(?:namespace_id|future_attachment)/);
      assert.ok(!output.includes("private-attachment-value"));
    }
  });
