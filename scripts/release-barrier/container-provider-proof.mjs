import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Redacted } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpClient from "effect/http/HttpClient";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import {
  containerDriftApi,
  digest,
  image,
} from "../upstream-tests/fixtures/container-drift-api.mjs";

const tree = process.argv[2];
const load = (name) =>
  import(
    new URL(
      `../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
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
globalThis.fetch = () => {
  throw new Error("Real network is forbidden in the container staging proof");
};
const context = mkdtempSync(join(tmpdir(), "container-staging-"));
writeFileSync(join(context, "Dockerfile"), "FROM scratch\nLABEL revision=old\n");
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
  env: { SYNTHETIC: Redacted.make("synthetic-value") },
};
const session = { note: () => Effect.void };
let publication;
let captures = 0;
let racingBuild = false;
let builds = 0;
let builtContext;
let builtTag;
let snapshotVerified = false;
const frozenDockerfile = "FROM scratch\nLABEL revision=frozen-publication\n";
const docker = {
  image: {
    build: (options) =>
      Effect.sync(() => {
        assert.equal(
          racingBuild,
          true,
          "Docker build is allowed only in the frozen-context fixture",
        );
        builds++;
        builtContext = options.context;
        builtTag = options.tag[0];
        assert.notEqual(options.context, context);
        writeFileSync(
          join(context, "Dockerfile"),
          "FROM scratch\nLABEL revision=changed-during-build\n",
        );
        chmodSync(join(context, "executable"), 0o644);
        assert.equal(readFileSync(options.file, "utf8"), frozenDockerfile);
        assert.equal(statSync(join(options.context, "executable")).mode & 0o777, 0o755);
        assert.equal(statSync(join(options.context, "empty")).mode & 0o777, 0o750);
        assert.equal(readlinkSync(join(options.context, "relative-link")), "executable");
        assert.equal(existsSync(join(options.context, "ignored")), false);
        snapshotVerified = true;
        api.registryMiss = false;
        api.publishedDigest = digest("5");
      }),
  },
};
const hook = {
  capture: (value) =>
    Effect.sync(() => {
      captures++;
      publication = value;
      return value.proposed;
    }),
};
const program = Effect.gen(function* () {
  const provider = yield* ContainerPlatform.Provider;
  const old = yield* provider.precreate({ id: "PoolContainer", news: props, session });
  api.app.durable_objects = { namespace_id: "fixture-namespace" };
  const previous = { ...old, durableObjects: { namespaceId: "fixture-namespace" } };
  const bindings = [{ data: { durableObjects: { namespaceId: "fixture-namespace" } } }];
  api.writes = 0;
  api.rollouts = 0;
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\nLABEL revision=new\n");
  api.publishedDigest = digest("3");
  const staged = yield* provider
    .reconcile({
      id: "PoolContainer",
      news: props,
      olds: props,
      bindings,
      output: previous,
      session,
    })
    .pipe(Effect.provideService(ContainerPublicationHook, hook));
  assert.equal(captures, 1);
  assert.equal(api.writes, 0);
  assert.equal(api.rollouts, 0);
  assert.notEqual(staged.hash.image, previous.hash.image);
  assert.equal(staged.configuration.image, image(digest("3")));
  assert.equal(staged.applicationId, previous.applicationId);
  assert.equal(Redacted.isRedacted(staged.dev.env.SYNTHETIC), true);
  assert.equal(Redacted.value(staged.dev.env.SYNTHETIC), "synthetic-value");
  assert.equal(publication.previous.version, previous.version);
  yield* publication.verifySource;
  writeFileSync(join(context, "Dockerfile"), "FROM scratch\nLABEL revision=changed-after-freeze\n");
  const drift = yield* Effect.exit(publication.verifySource);
  assert.equal(drift._tag, "Failure");
  api.publishedDigest = digest("4");
  const registryReads = api.registryReads;
  const rolled = yield* publication.rollout();
  assert.equal(rolled.current_version, previous.version);
  assert.equal(rolled.target_version, previous.version + 1);
  assert.equal(api.app.configuration.image, image(digest("3")));
  assert.equal(api.registryReads, registryReads);
  assert.equal(api.rollouts, 1);
  assert.equal(api.updates.length, 0);
  assert.equal(api.writes, 1);
  // A source edit while Docker reads cannot publish different bytes under the earlier hash.
  const active = { ...staged, version: rolled.target_version };
  writeFileSync(join(context, "Dockerfile"), frozenDockerfile);
  writeFileSync(join(context, "executable"), "fixture executable");
  chmodSync(join(context, "executable"), 0o755);
  mkdirSync(join(context, "empty"), { mode: 0o750 });
  symlinkSync("executable", join(context, "relative-link"));
  writeFileSync(join(context, ".dockerignore"), "ignored\n");
  writeFileSync(join(context, "ignored"), "not a build input");
  api.registryMiss = true;
  racingBuild = true;
  const raced = yield* Effect.exit(
    provider
      .reconcile({
        id: "PoolContainer",
        news: props,
        olds: props,
        bindings,
        output: active,
        session,
      })
      .pipe(Effect.provideService(ContainerPublicationHook, hook)),
  );
  assert.equal(raced._tag, "Failure");
  assert.equal(captures, 1);
  assert.equal(builds, 1);
  assert.equal(
    snapshotVerified,
    true,
    "Docker must consume the frozen bytes and modes despite the source edit",
  );
  assert.equal(existsSync(builtContext), false, "the publisher owns and closes its snapshot");
  writeFileSync(join(context, "Dockerfile"), frozenDockerfile);
  chmodSync(join(context, "executable"), 0o755);
  const reused = yield* provider
    .reconcile({ id: "PoolContainer", news: props, olds: props, bindings, output: active, session })
    .pipe(Effect.provideService(ContainerPublicationHook, hook));
  assert.equal(reused.hash.image, builtTag.slice(builtTag.lastIndexOf(":") + 1));
  assert.equal(reused.hash.digest, digest("5"));
  assert.equal(
    builds,
    1,
    "a later clean attempt reuses only bytes built from the matching frozen snapshot",
  );
  assert.equal(api.writes, 1, "publishing unused image bytes never activates an application");
  // A hook refuses identity/attachment recovery before the ordinary delete/create paths.
  const before = api.writes;
  const missing = yield* Effect.exit(
    provider
      .precreate({ id: "PoolContainer", news: props, session })
      .pipe(Effect.provideService(ContainerPublicationHook, hook)),
  );
  assert.equal(missing._tag, "Failure");
  const changedAttachment = yield* Effect.exit(
    provider
      .reconcile({
        id: "PoolContainer",
        news: props,
        bindings: [{ data: { durableObjects: { namespaceId: "foreign" } } }],
        output: staged,
        session,
      })
      .pipe(Effect.provideService(ContainerPublicationHook, hook)),
  );
  assert.equal(changedAttachment._tag, "Failure");
  api.applicationExists = false;
  const gone = yield* Effect.exit(
    provider
      .reconcile({ id: "PoolContainer", news: props, bindings, output: staged, session })
      .pipe(Effect.provideService(ContainerPublicationHook, hook)),
  );
  assert.equal(gone._tag, "Failure");
  assert.equal(api.writes, before);
}).pipe(
  Effect.provide(LiveContainerProvider()),
  Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy" }),
  Effect.provideService(InstanceId, "1".repeat(32)),
  Effect.provideService(Docker, docker),
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
  console.log("__CONTAINER_PROOF_PASS__");
} finally {
  rmSync(context, { recursive: true, force: true });
}
