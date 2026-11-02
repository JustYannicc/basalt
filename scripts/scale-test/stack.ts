import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Docker from "alchemy/Docker";
import * as Output from "alchemy/Output";
import * as Planetscale from "alchemy/Planetscale";
import { Stage } from "alchemy/Stage";
import { Config, Effect, FileSystem, Layer, Redacted } from "effect";
import { poolDatabaseUrl } from "@basalt-scale/candidate/src/pool/database-settings.ts";
import { database, prefix, stage, worker } from "./settings.ts";

// This stack owns no DNS, production bindings, retained databases or shared app resources.
export default Alchemy.Stack(prefix, {
  providers: Layer.mergeAll(Cloudflare.providers(), Planetscale.providers(), Command.providers(), Docker.providers()),
  state: Alchemy.localState(),
}, Effect.gen(function* () {
  if ((yield* Stage) !== stage) return yield* Effect.die(new Error("Only scale-180 is allowed"));
  const cluster = yield* Planetscale.PostgresDatabase("Database", {
    name: database, clusterSize: "PS_5", region: { slug: "eu-central" }, replicas: 0,
  });
  const admin = yield* Planetscale.PostgresRole("MigrationRole", { database: cluster, inheritedRoles: ["postgres"] });
  const runtime = yield* Planetscale.PostgresRole("PoolDatabaseRole", { database: cluster, inheritedRoles: [] });
  const ready = yield* Command.Exec("PoolDatabase", {
    command: "node ensure-pool-database.ts",
    cwd: new URL("../../.local/scale-candidate/scripts/", import.meta.url).pathname,
    env: { POOL_DATABASE_ADMIN_URL: admin.connectionUrl, POOL_DATABASE_RUNTIME_ROLE: runtime.username },
    memo: false, timeout: "3 minutes",
  });
  const fs = yield* FileSystem.FileSystem;
  const authority = yield* Cloudflare.MtlsCertificate.MtlsCertificate("DatabaseCertificateAuthority", {
    name: `${prefix}-ca`, ca: true,
    certificates: yield* fs.readFileString(new URL("../../.local/scale-candidate/.upstream/apps/hosted/cloud/certificates/isrg-root-x1.pem", import.meta.url).pathname).pipe(Effect.orDie),
  });
  const workerDatabase = yield* Cloudflare.Hyperdrive.Connection("PoolModelDatabaseConnection", {
    name: `${prefix}-auth`,
    origin: Output.all(runtime.origin, ready.hash).pipe(Output.map(([origin]) => ({ ...origin, database: "basalt_pool" }))),
    caching: { disabled: true }, originConnectionLimit: 5,
    mtls: { sslmode: "verify-full", caCertificateId: authority.mtlsCertificateId },
  });
  const constraints: Cloudflare.ContainerApplication.Constraints & { jurisdiction: "eu"; regions: ("EEUR" | "WEUR")[] } = {
    jurisdiction: "eu", regions: ["EEUR", "WEUR"],
  };
  const pool = Cloudflare.Container("PoolContainer", {
    name: `${prefix}-pool`, image: yield* Config.NonEmptyString("SCALE_IMAGE"), className: "PoolContainer",
    schedulingPolicy: "default", instanceType: yield* Config.Literals(["lite", "basic", "standard-2"], "SCALE_SIZE"),
    maxInstances: 1, constraints, observability: { logs: { enabled: true } },
  });
  const fixture = (id: "Mock" | "Generator", instanceType: "standard-2" | "standard-4") => Cloudflare.Container(id, {
    name: `${prefix}-${id.toLowerCase()}`, className: id,
    image: "python:3.12-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337",
    schedulingPolicy: "default", instanceType, maxInstances: 1, constraints,
  });
  return yield* Cloudflare.Worker("Gateway", {
    name: worker, main: new URL("./worker.ts", import.meta.url).pathname,
    workersDev: true, compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    env: {
      PoolContainer: pool, Mock: fixture("Mock", "standard-2"), Generator: fixture("Generator", "standard-4"),
      POOL_DATABASE_URL: Output.all(runtime.connectionUrl, ready.hash).pipe(Output.map(([url]) => Redacted.make(poolDatabaseUrl(Redacted.value(url))))),
      POOL_AUTH_DATABASE: workerDatabase,
      POOL_MANAGEMENT_KEY: yield* Config.Redacted("SCALE_MANAGEMENT"),
      POOL_APP_SIGNING_KEY: yield* Config.Redacted("SCALE_SIGNING"),
      POOL_IMAGE_HASH: yield* Config.NonEmptyString("SCALE_IMAGE"),
      TEST_ADMIN: yield* Config.Redacted("SCALE_ADMIN"),
      TEST_KEY_SEED: yield* Config.Redacted("SCALE_SEED"),
      TEST_DEADLINE: yield* Config.NonEmptyString("SCALE_DEADLINE"),
      TEST_ORIGIN: yield* Config.NonEmptyString("SCALE_ORIGIN"),
    },
  });
}));
