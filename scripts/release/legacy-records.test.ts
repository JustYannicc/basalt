import assert from "node:assert/strict";
import { createDecipheriv, hkdfSync } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import { canonical, digest } from "../pool-fleet/manifest.ts";
import { sealRecovery } from "../pool-history/recovery-envelope.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";
import { assertNoUnresolvedHome, exportLegacyRecords, stateRows } from "./legacy-records.ts";

const key = "f".repeat(64);
const scratch = () =>
  mkdtemp(join(process.env.RUNNER_TEMP ?? join(homedir(), "Library", "Caches"), "legacy-records-"));
const memory = () => Effect.runPromise(InMemoryService());

function open(file: { record: string; iv: string; tag: string; ciphertext: string }) {
  const derived = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(key, "hex"),
      Buffer.from(file.record),
      "basalt-legacy-records-v1",
      32,
    ),
  );
  const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(file.iv, "base64"));
  decipher.setAAD(Buffer.from(file.record));
  decipher.setAuthTag(Buffer.from(file.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, "base64")),
    decipher.final(),
  ]).toString();
}

test("every side-stack record and the two embedded maps are exported sealed, nothing else", async () => {
  const state = await memory();
  const stage = "production";
  const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
  await run(
    state.setOutput({ stack: "basalt-release-barrier", stage, value: { packet: "forward" } }),
  );
  await run(
    state.setOutput({
      stack: "basalt-runtime-image-release",
      stage,
      value: { head: "init-5c68c6ab" },
    }),
  );
  await run(
    state.setOutput({ stack: "basalt-release-settlement-abc", stage, value: { archive: 1 } }),
  );
  await run(
    state.setOutput({
      stack: "basalt",
      stage,
      value: {
        $basaltDeclaredChanges: { d1: "id" },
        $basaltDeclaredClasses: { PoolWorker: 1 },
        app: "url",
      },
    }),
  );
  const directory = await scratch();
  const exported = await run(
    exportLegacyRecords(state, stage, directory, key, ["basalt-release-settlement-abc"]),
  );
  assert.deepEqual(exported.map((entry) => entry.record).sort(), [
    "basalt-release-barrier",
    "basalt-release-settlement-abc",
    "basalt-runtime-image-release",
    "basalt.$basaltDeclaredChanges",
    "basalt.$basaltDeclaredClasses",
  ]);
  const files = (await readdir(directory)).sort();
  assert.equal(files.length, 5);
  for (const name of files) {
    const sealed = JSON.parse(await readFile(join(directory, name), "utf8"));
    assert.equal(sealed.format, "basalt-legacy-record-v1");
    assert.doesNotMatch(JSON.stringify(sealed), /init-5c68c6ab|forward|PoolWorker/u);
    assert.ok(open(sealed).length > 0);
  }
  const image = JSON.parse(
    open(JSON.parse(await readFile(join(directory, "basalt-runtime-image-release.json"), "utf8"))),
  );
  assert.deepEqual(image, { head: "init-5c68c6ab" });
});

test("the State rows of the stage are listed with type, status and removal policy", async () => {
  const state = await memory();
  await Effect.runPromise(
    state.set({
      stack: "basalt",
      stage: "production",
      fqn: "PoolProviderObservationToken",
      value: {
        resourceType: "Cloudflare.ApiToken.AccountApiToken",
        status: "created",
        removalPolicy: "retain",
      } as never,
    }),
  );
  assert.deepEqual(await Effect.runPromise(stateRows(state, "production")), [
    {
      fqn: "PoolProviderObservationToken",
      type: "Cloudflare.ApiToken.AccountApiToken",
      status: "created",
      removalPolicy: "retain",
    },
  ]);
});

const candidate = "a".repeat(40);

/** A settled journal, sealed as the retired layer's writer stored it. */
async function journal(state: Awaited<ReturnType<typeof memory>>) {
  const receipt = readySqlSchemas(candidate);
  const fingerprint = digest(
    canonical({ candidate: candidate, homeImageDigest: receipt.homeImageDigest }),
  );
  await Effect.runPromise(
    state.setOutput({
      stack: "basalt-sql-schema-barrier",
      stage: "production",
      value: {
        schemaVersion: 1,
        candidate: candidate,
        fingerprint,
        sealed: sealRecovery({ receipt, unresolvedHome: null }, key, candidate, fingerprint),
      },
    }),
  );
}
const check = (state: Awaited<ReturnType<typeof memory>>) =>
  Effect.runPromiseExit(
    assertNoUnresolvedHome("production", key).pipe(
      Effect.provideService(State, Effect.succeed(state)),
    ),
  );

test("no journal, or a settled one, lets the cutover start", async () => {
  const state = await memory();
  assert.ok(Exit.isSuccess(await check(state)));
  await journal(state);
  assert.ok(Exit.isSuccess(await check(state)));
});

test("an unresolved Home migration stops the cutover and names it", async () => {
  const state = await memory();
  const exit = await Effect.runPromiseExit(
    assertNoUnresolvedHome("production", key, () =>
      Effect.succeed({ unresolvedHome: { intentId: "intent-1", targetVersion: 2 } }),
    ).pipe(Effect.provideService(State, Effect.succeed(state))),
  );
  assert.ok(Exit.isFailure(exit));
  assert.match(JSON.stringify(exit), /home-schema-unresolved.*"targetVersion":2/u);
});

test("an unreadable journal stops the cutover", async () => {
  const state = await memory();
  await Effect.runPromise(
    state.setOutput({
      stack: "basalt-sql-schema-barrier",
      stage: "production",
      value: { sealed: "garbage" },
    }),
  );
  const exit = await check(state);
  assert.match(JSON.stringify(exit), /home-schema-receipt-unreadable/u);
});
