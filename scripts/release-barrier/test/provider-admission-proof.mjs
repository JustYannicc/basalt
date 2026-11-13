import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpClient from "effect/http/HttpClient";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { containerDriftApi, digest } from "../../upstream-tests/fixtures/container-drift-api.mjs";
import { stageContainer } from "../container.ts";
import { releaseHomeImage } from "../home-schema-image.ts";
import { homeSchemaAdmission } from "../home-schema-admission.ts";

const tree = process.argv[2];
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const [
  { LiveContainerProvider },
  { ContainerPlatform },
  { ContainerPublicationHook },
  { AlchemyContext },
  { CloudflareEnvironment },
  { Docker },
  { InstanceId },
] = await Promise.all([
  load("Cloudflare/Containers/ContainerProvider"),
  load("Cloudflare/Containers/ContainerPlatform"),
  load("Cloudflare/Containers/ContainerPublicationHook"),
  load("AlchemyContext"),
  load("Cloudflare/CloudflareEnvironment"),
  load("Docker/Docker"),
  load("InstanceId"),
]);
// Keep the producer real: no local hash formula can stand in for the publication hook.
globalThis.fetch = () => {
  throw new Error("Real network is forbidden in the admission proof");
};
const temporary = mkdtempSync(join(tmpdir(), "provider-admission-"));
const context = process.argv[3] || join(temporary, "context");
if (!process.argv[3]) mkdirSync(context);
if (!process.argv[3])
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\nLABEL revision=admission\n");
const api = containerDriftApi({ rolloutOnly: true });
api.applicationExists = false;
const props = {
  name: "fixture-pool",
  context,
  className: "PoolContainer",
  instanceType: "basic",
  maxInstances: 1,
  schedulingPolicy: "default",
  constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
};
const session = { note: () => Effect.void };
const baseline = process.argv[5] || "0e2ecb6f105a95f3";
assert.match(baseline, /^[a-f0-9]{16}$/u);
let publication;
const hook = {
  rolloutKind: "full_manual",
  capture: (value) =>
    Effect.sync(() => {
      publication = value;
      return value.proposed;
    }),
};
const program = Effect.gen(function* () {
  const provider = yield* ContainerPlatform.Provider;
  const old = yield* provider.precreate({ id: "PoolContainer", news: props, session });
  api.app.durable_objects = { namespace_id: "fixture-namespace" };
  const previous = {
    ...old,
    hash: { ...old.hash, image: baseline },
    durableObjects: { namespaceId: "fixture-namespace" },
  };
  api.writes = 0;
  api.publishedDigest = digest("3");
  yield* provider
    .reconcile({
      id: "PoolContainer",
      news: props,
      olds: props,
      output: previous,
      session,
      bindings: [{ data: { durableObjects: { namespaceId: "fixture-namespace" } } }],
    })
    .pipe(Effect.provideService(ContainerPublicationHook, hook));
  assert.ok(publication);
  const staged = yield* stageContainer(publication, props, props, previous, () =>
    Effect.succeed({
      digest: publication.proposed.hash.digest,
      configDigest: digest("4"),
      platform: "linux/amd64",
      capabilityLabel: "1",
    }),
  );
  const selected = yield* releaseHomeImage(
    { name: "fixture", stage: "production" },
    "a".repeat(40),
    {},
    {},
    [staged.frozen],
    {
      token: Effect.succeed("synthetic-never-sent"),
      observe: () => Effect.die("Changed image cannot consult fallback state"),
      inspect: () => {
        throw new Error("Staging already inspected the image");
      },
    },
  );
  assert.equal(selected.identity.sourceInputHash, publication.proposed.hash.image);
  assert.equal(selected.identity.baselineInputHash, baseline);
  const info = { format_version: 1, target_version: 16, required_indexes: ["idx_fixture"] };
  const before = {
    format_version: 1,
    target_version: 16,
    previous_version: null,
    applied_version: 15,
    status: "pending",
    indexes_checked: false,
    pending_indexes: [],
    reason: "schema_pending",
  };
  let admissionRoot = process.argv[4];
  if (!admissionRoot) {
    admissionRoot = temporary;
    mkdirSync(join(temporary, "scripts/release-barrier"), { recursive: true });
    writeFileSync(
      join(temporary, "scripts/release-barrier/home-schema-admissions.json"),
      JSON.stringify({
        format_version: 1,
        transitions: [
          {
            baselineInputHash: baseline,
            candidateInputHash: publication.proposed.hash.image,
            fromVersions: [15, 16],
            targetVersion: 16,
            requiredIndexes: info.required_indexes,
          },
        ],
      }),
    );
  } else {
    const { readFileSync } = yield* Effect.promise(() => import("node:fs"));
    const declarations = JSON.parse(
      readFileSync(
        join(admissionRoot, "scripts/release-barrier/home-schema-admissions.json"),
        "utf8",
      ),
    );
    info.required_indexes = declarations.transitions[0].requiredIndexes;
  }
  yield* publication.verifySource;
  const admit = yield* Effect.promise(() => homeSchemaAdmission(admissionRoot));
  assert.equal(
    admit(selected.identity, info, before),
    true,
    "checked admission must accept the provider publication hash",
  );
  const { computeStaticSourceHash } = yield* Effect.promise(() => load("Docker/ImageSource"));
  const staticHash = yield* computeStaticSourceHash({ context }, "linux/amd64");
  assert.notEqual(staticHash, selected.identity.sourceInputHash);
  const rejectedCandidateHashes = [
    ...new Set([
      staticHash,
      "c7646255244ef2e0",
      "f10a204af47e623f",
      "349077fb12a21f30",
      "0152ede472b6f78e",
      "f0306fefc74fbf8d",
      "cc52df39f1c5cd82",
      "ef1236d5c3f08c04",
      "2fe25d81b60b7025",
      "6842d68639bcd135",
      "4290c0e3ed44b007",
    ]),
  ];
  for (const sourceInputHash of rejectedCandidateHashes)
    assert.equal(admit({ ...selected.identity, sourceInputHash }, info, before), false);
  assert.equal(
    admit({ ...selected.identity, baselineInputHash: "f".repeat(16) }, info, before),
    false,
  );
  assert.equal(api.writes, 0);
  assert.equal(api.rollouts, 0);
  console.log(
    JSON.stringify({
      tree,
      publicationHash: selected.identity.sourceInputHash,
      rejectedStaticHash: staticHash,
      rejectedCandidateHashes,
      baseline,
      postStagingWrites: api.writes,
      rollouts: api.rollouts,
    }),
  );
}).pipe(
  Effect.provide(LiveContainerProvider()),
  Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy" }),
  Effect.provideService(InstanceId, "1".repeat(32)),
  Effect.provideService(Docker, {
    image: { build: () => Effect.die("Docker builds are forbidden") },
  }),
  Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: "fixture" })),
  Effect.provideService(HttpClient.HttpClient, api.http),
  Effect.provideService(
    Credentials,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("synthetic-never-sent"),
      apiBaseUrl: "https://fixture.invalid",
    }),
  ),
  Effect.provide(NodeServices.layer),
);
try {
  await Effect.runPromise(program);
  console.log("__PROVIDER_ADMISSION_PASS__");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
