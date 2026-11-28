import assert from "node:assert/strict";
import { test } from "node:test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Schema } from "../.upstream/node_modules/effect/dist/index.js";
import { FetchHttpClient } from "../.upstream/node_modules/effect/dist/http/index.js";
import {
  EmulatedServices,
  HostedOrLoopbackUrl,
} from "../.upstream/apps/hosted/cloud/src/contracts/emulators.ts";
import { AutumnServerUrl } from "../.upstream/apps/hosted/cloud/src/contracts/autumn.ts";
import { EmulatorFixture } from "../.upstream/e2e/support/emulators.ts";
import {
  localAutumnEmulator,
  localServiceEmulators,
} from "../.upstream/e2e/support/autumn-emulator.ts";

// CI runs the emulators on loopback beside a local Cloud (#642, #1970). Only the emulator
// configuration may name them, and Cloud reads it only on a loopback dev origin or a test-e2e-
// stage; an operator's Autumn endpoint stays HTTPS.
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

/** Every service on one loopback emulator, as `localServiceEmulators` starts them. */
const loopback = (port: number) => `http://localhost:${port}`;
const allLocal = () => ({
  google: {
    baseUrl: loopback(41300),
    clientId: "client",
    clientSecret: "secret",
    discovery: discovery(loopback(41300)),
  },
  github: { baseUrl: loopback(41301), clientId: "client", clientSecret: "secret" },
  mail: { baseUrl: loopback(41302), token: "x" },
  company: { baseUrl: loopback(41303), token: "x" },
  billing: { baseUrl: local, token: "am_sk_test_x" },
  workos: { baseUrl: loopback(41304), token: "x" },
});
const keyedServices = ["mail", "company", "billing", "workos"] as const;

test("Cloud's emulator configuration accepts a loopback emulator for every service", () => {
  assert.ok(accepts(EmulatedServices, services()));
  assert.ok(accepts(EmulatedServices, allLocal()));
  assert.ok(accepts(EmulatedServices, billingAt("http://localhost:41234")));
  for (const service of keyedServices)
    for (const baseUrl of refused)
      assert.ok(
        !accepts(EmulatedServices, services({ [service]: { baseUrl, token: "x" } })),
        `${service} ${baseUrl}`,
      );
  for (const baseUrl of refused) {
    assert.ok(
      !accepts(EmulatedServices, {
        ...services(),
        github: { baseUrl, clientId: "c", clientSecret: "s" },
      }),
      `github ${baseUrl}`,
    );
    assert.ok(
      !accepts(EmulatedServices, {
        ...services(),
        google: { baseUrl, clientId: "c", clientSecret: "s", discovery: discovery(baseUrl) },
      }),
      `google ${baseUrl}`,
    );
  }
});

test("Google's discovery must lie under its own base, so hosted and loopback never mix", () => {
  const google = (baseUrl: string, at: string) => ({
    ...services(),
    google: { baseUrl, clientId: "c", clientSecret: "s", discovery: discovery(at) },
  });
  assert.ok(accepts(EmulatedServices, google(loopback(41300), loopback(41300))));
  assert.ok(!accepts(EmulatedServices, google(loopback(41300), hosted("google"))));
  assert.ok(!accepts(EmulatedServices, google(hosted("google"), loopback(41300))));
  assert.ok(!accepts(EmulatedServices, google(loopback(41300), loopback(41399))));
});

// The guard Cloud's every emulator read goes through (`cloudEmulators`), given the stage and origin
// an operator could configure. Loopback stand-ins are accepted only where emulators are.
test("a loopback emulator is refused on every stage but a test one, for every service", async () => {
  const cloud = "../.upstream/apps/hosted/cloud/node_modules/effect/dist/index.js";
  const { ConfigProvider, Effect: CloudEffect, Exit: CloudExit } = await import(cloud);
  const { cloudEmulators } =
    await import("../.upstream/apps/hosted/cloud/src/infrastructure/emulators.ts");
  const read = async (configuration: unknown, stage: string | undefined, origin: string) => {
    const env: Record<string, string> = {
      BETTER_AUTH_URL: origin,
      EXECUTOR_EMULATORS: JSON.stringify(configuration),
      ...(stage === undefined ? {} : { ALCHEMY_STAGE: stage }),
    };
    const exit = await CloudEffect.runPromiseExit(
      cloudEmulators.pipe(
        CloudEffect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
      ),
    );
    return CloudExit.isSuccess(exit);
  };
  const placements: Array<[string, string | undefined, string, boolean]> = [
    ["Cloud dev on loopback", undefined, "http://localhost:4411", true],
    // How CI's local Cloud runs: a random `e2e-` stage on its loopback origin.
    ["a local Cloud's own stage", "e2e-0123456789abcdef", "http://localhost:4411", true],
    ["a test-e2e- stage", "test-e2e-local", "https://unused.example", true],
    ["production", "v2", "https://executor.sh", false],
    ["another test stage", "test-preview-one", "https://unused.example", false],
    ["a deployment without a stage", undefined, "https://executor.sh", false],
    ["a dev origin that is not loopback", undefined, "http://192.0.2.10:4411", false],
  ];
  for (const service of ["google", "github", "mail", "company", "billing", "workos"] as const) {
    const configuration = { ...services(), [service]: allLocal()[service] };
    for (const [where, stage, origin, allowed] of placements)
      assert.equal(await read(configuration, stage, origin), allowed, `${service} on ${where}`);
  }
});

test("an emulator endpoint is a hosted instance or a loopback emulator, never Autumn itself", () => {
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

test("the harness fixture names a loopback emulator for every service", () => {
  const fixture = (value: ReturnType<typeof services>) => ({
    version: 4,
    origin: "http://localhost:4411",
    services: value,
  });
  assert.ok(accepts(EmulatorFixture, fixture(billingAt(local))));
  assert.ok(accepts(EmulatorFixture, fixture(allLocal())));
  for (const service of keyedServices)
    for (const baseUrl of refused)
      assert.ok(
        !accepts(EmulatorFixture, fixture(services({ [service]: { baseUrl, token: "x" } }))),
        `${service} ${baseUrl}`,
      );
  for (const baseUrl of refused) {
    const github = { baseUrl, clientId: "c", clientSecret: "s" };
    const google = { ...github, discovery: discovery(baseUrl) };
    assert.ok(!accepts(EmulatorFixture, fixture({ ...services(), github })), `github ${baseUrl}`);
    assert.ok(!accepts(EmulatorFixture, fixture({ ...services(), google })), `google ${baseUrl}`);
  }
});

test("without a configured emulator CLI, a local Cloud starts nothing and keeps every service hosted", async () => {
  const configured = process.env.BASALT_E2E_AUTUMN_EMULATOR;
  delete process.env.BASALT_E2E_AUTUMN_EMULATOR;
  try {
    const started = await Effect.runPromise(
      Effect.scoped(
        Effect.all([
          localAutumnEmulator("/nonexistent/cloud"),
          localServiceEmulators("/nonexistent/cloud"),
        ]),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
    );
    assert.deepEqual(started, [undefined, undefined]);
  } finally {
    if (configured !== undefined) process.env.BASALT_E2E_AUTUMN_EMULATOR = configured;
  }
});
