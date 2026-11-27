import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Redacted } from "../../.upstream/node_modules/effect/dist/index.js";
import { FetchHttpClient } from "../../.upstream/node_modules/effect/dist/http/index.js";
import {
  localAutumnEmulator,
  localServiceEmulators,
} from "../../.upstream/e2e/support/autumn-emulator.ts";
import { createEmulatorFixture } from "../../.upstream/e2e/support/emulators.ts";

// Runs only where CI built the emulate CLI (`setup-service-emulators`), and fails without it.
const entry = process.env.BASALT_E2E_AUTUMN_EMULATOR;

const listening = (origin: string) =>
  new Promise<boolean>((resolve) => {
    const url = new URL(origin);
    const socket = connect(Number(url.port), "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

test("a local Cloud's fixture keys every service on its own loopback emulator", async () => {
  assert.ok(entry, "BASALT_E2E_AUTUMN_EMULATOR names the emulate CLI");
  const directory = mkdtempSync(join(tmpdir(), "basalt-local-emulators-"));
  let started: Record<string, string> | undefined;
  try {
    const services = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const billing = yield* localAutumnEmulator(directory);
          const local = yield* localServiceEmulators(directory);
          assert.ok(billing && local);
          started = { ...local, autumn: billing };
          const fixture = yield* createEmulatorFixture("http://localhost:4411", billing, local);
          // Every origin still answers while its scope is open.
          for (const origin of Object.values(started))
            assert.ok(yield* Effect.promise(() => listening(origin)), origin);
          return { local, billing, value: Redacted.value(fixture).services };
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
    );
    const { local, billing, value } = services;
    assert.equal(value.google.baseUrl, local.google);
    assert.equal(value.google.discovery.issuer, local.google);
    assert.equal(value.github.baseUrl, local.github);
    assert.equal(value.mail.baseUrl, local.resend);
    assert.equal(value.company.baseUrl, local.context);
    assert.equal(value.workos.baseUrl, local.workos);
    assert.equal(value.billing.baseUrl, billing);
    // No hosted instance was asked for: every base is this run's own loopback emulator.
    for (const baseUrl of [
      value.google.baseUrl,
      value.github.baseUrl,
      value.mail.baseUrl,
      value.company.baseUrl,
      value.workos.baseUrl,
      value.billing.baseUrl,
    ])
      assert.match(baseUrl, /^http:\/\/(?:localhost|127\.0\.0\.1):\d+$/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Closing the scope stopped every emulator it started.
  for (const origin of Object.values(started ?? {}))
    assert.equal(await listening(origin), false, `${origin} still listens`);
});

test("local Clouds started together each get their own stand-ins", async () => {
  assert.ok(entry, "BASALT_E2E_AUTUMN_EMULATOR names the emulate CLI");
  const directories = Array.from({ length: 10 }, () =>
    mkdtempSync(join(tmpdir(), "basalt-local-emulators-")),
  );
  try {
    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.forEach(
          directories,
          (directory) =>
            Effect.all([localAutumnEmulator(directory), localServiceEmulators(directory)]),
          { concurrency: "unbounded" },
        ),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
    );
    const origins = started.flatMap(([billing, local]) => [billing!, ...Object.values(local!)]);
    assert.equal(new Set(origins.map((origin) => new URL(origin).port)).size, origins.length);
    // Closing the scope gave every reserved port back.
    const reserved = join(tmpdir(), "basalt-emulator-ports");
    for (const origin of origins)
      assert.equal(existsSync(join(reserved, new URL(origin).port)), false, origin);
  } finally {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  }
});
