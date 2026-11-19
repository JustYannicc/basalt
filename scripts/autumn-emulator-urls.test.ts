import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Schema } from "../.upstream/node_modules/effect/dist/index.js";
import * as cloudEmulators from "../.upstream/apps/hosted/cloud/src/contracts/emulators.ts";
import { AutumnServerUrl } from "../.upstream/apps/hosted/cloud/src/contracts/autumn.ts";
import { EmulatorFixture } from "../.upstream/e2e/support/emulators.ts";
import { localAutumnEmulator } from "../.upstream/e2e/support/autumn-emulator.ts";

// CI runs the Autumn billing emulator on loopback (#642). Only the emulator configuration may name
// it, and only for billing; an operator's Autumn endpoint stays HTTPS.
const local = "http://127.0.0.1:41234";
const hosted = (service: string) => `https://${service}.emulators.dev/${service}/instance-1`;
const keyed = (service: string) => ({ baseUrl: hosted(service), token: `${service}-token` });
const discovery = (baseUrl: string) => ({
  issuer: baseUrl,
  authorization_endpoint: `${baseUrl}/o/oauth2/v2/auth`,
  token_endpoint: `${baseUrl}/oauth2/token`,
  userinfo_endpoint: `${baseUrl}/oauth2/v2/userinfo`,
  jwks_uri: `${baseUrl}/oauth2/v3/certs`,
  id_token_signing_alg_values_supported: ["RS256"],
});
const services = (overrides: Record<string, { baseUrl: string; token: string }> = {}) => ({
  google: {
    baseUrl: hosted("google"),
    clientId: "client",
    clientSecret: "secret",
    discovery: discovery(hosted("google")),
  },
  github: { baseUrl: hosted("github"), clientId: "client", clientSecret: "secret" },
  mail: keyed("resend"),
  company: keyed("context"),
  billing: keyed("autumn"),
  workos: keyed("workos"),
  ...overrides,
});
const accepts = (schema: Schema.ConstraintDecoder<unknown>, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema)(value));
const billingAt = (baseUrl: string) => services({ billing: { baseUrl, token: "am_sk_test_x" } });
const refused = [
  "http://192.0.2.10:41234",
  "http://autumn.emulators.dev",
  `${local}/`,
  `${local}?key=x`,
  "http://user:pass@127.0.0.1:41234",
];

test("Cloud's emulator configuration accepts a loopback Autumn emulator for billing", () => {
  assert.ok(accepts(cloudEmulators.EmulatedServices, services()));
  assert.ok(accepts(cloudEmulators.EmulatedServices, billingAt(local)));
  assert.ok(accepts(cloudEmulators.EmulatedServices, billingAt("http://localhost:41234")));
  for (const baseUrl of refused)
    assert.ok(!accepts(cloudEmulators.EmulatedServices, billingAt(baseUrl)), baseUrl);
  for (const service of ["mail", "company", "workos"])
    assert.ok(
      !accepts(
        cloudEmulators.EmulatedServices,
        services({ [service]: { baseUrl: local, token: "x" } }),
      ),
      service,
    );
});

test("billing's emulator branch accepts exactly what the emulator configuration does", () => {
  const { HostedOrLoopbackUrl } = cloudEmulators as Record<
    string,
    Schema.ConstraintDecoder<unknown> | undefined
  >;
  assert.ok(HostedOrLoopbackUrl, "contracts/emulators.ts exports the emulator endpoint schema");
  assert.ok(accepts(HostedOrLoopbackUrl, local));
  assert.ok(accepts(HostedOrLoopbackUrl, hosted("autumn")));
  for (const baseUrl of [...refused, "https://api.useautumn.com"])
    assert.ok(!accepts(HostedOrLoopbackUrl, baseUrl), baseUrl);
});

test("an operator's Autumn endpoint stays HTTPS", () => {
  assert.ok(accepts(AutumnServerUrl, "https://api.useautumn.com"));
  assert.ok(!accepts(AutumnServerUrl, local));
  assert.ok(!accepts(AutumnServerUrl, "http://localhost:41234"));
});

test("the harness fixture names a loopback emulator only for billing", () => {
  const fixture = (value: ReturnType<typeof services>) => ({
    version: 4,
    origin: "http://localhost:4411",
    services: value,
  });
  assert.ok(accepts(EmulatorFixture, fixture(billingAt(local))));
  for (const baseUrl of refused)
    assert.ok(!accepts(EmulatorFixture, fixture(billingAt(baseUrl))), baseUrl);
  for (const service of ["mail", "company", "workos"])
    assert.ok(
      !accepts(EmulatorFixture, fixture(services({ [service]: { baseUrl: local, token: "x" } }))),
      service,
    );
});

test("without a configured emulator CLI, a local Cloud starts nothing and keeps hosted billing", async () => {
  const configured = process.env.BASALT_E2E_AUTUMN_EMULATOR;
  delete process.env.BASALT_E2E_AUTUMN_EMULATOR;
  try {
    const origin = await Effect.runPromise(
      Effect.scoped(localAutumnEmulator("/nonexistent/cloud")).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    assert.equal(origin, undefined);
  } finally {
    if (configured !== undefined) process.env.BASALT_E2E_AUTUMN_EMULATOR = configured;
  }
});
