import * as R2 from "@distilled.cloud/cloudflare/r2";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { Effect, Option, Schema } from "effect";
import type { BucketTarget, BucketObservation } from "./declared-buckets.ts";
import type { PropChange } from "./prop-diff.ts";
import { declaredMismatch } from "./declared-refusal.ts";
import { BarrierRefusal, digest } from "./manifest.ts";

export const bucketAccount = Effect.gen(function* () {
  const environment = yield* Effect.serviceOption(CloudflareEnvironment);
  if (Option.isNone(environment))
    throw declaredMismatch(
      "missing-declared-bucket-account",
      "release-declarations.json",
      { accountScope: "configured" },
      { accountScope: null },
    );
  return (yield* environment.value).accountId;
});

export const readDeclaredBucket = (target: BucketTarget, fqn = "declared-bucket") =>
  Effect.gen(function* () {
    const request = {
      accountId: target.accountId,
      bucketName: target.bucketName,
      jurisdiction: target.jurisdiction,
    };
    const bucket = yield* R2.getBucket(request).pipe(
      Retry.none,
      Effect.catchTag("NoSuchBucket", () => Effect.succeed(undefined)),
    );
    if (!bucket) return undefined;
    const managed = yield* R2.listBucketDomainManageds(request).pipe(Retry.none);
    const domains = yield* R2.listBucketDomainCustoms(request).pipe(Retry.none);
    const cors = yield* R2.getBucketCors(request).pipe(
      Retry.none,
      Effect.catchTag("NoCorsConfiguration", () => Effect.succeed({ rules: [] })),
    );
    const lifecycle = yield* R2.getBucketLifecycle(request).pipe(Retry.none);
    const changed: PropChange[] = [];
    if (bucket.name !== target.bucketName)
      changed.push({
        path: "bucketName.sha256",
        old: digest(target.bucketName),
        new: typeof bucket.name === "string" ? digest(bucket.name) : null,
      });
    if (bucket.jurisdiction !== "eu")
      changed.push({
        path: "jurisdiction",
        old: "eu",
        new: ["default", "us", "fedramp", "fedramp-high"].includes(bucket.jurisdiction ?? "")
          ? bucket.jurisdiction!
          : null,
      });
    if (bucket.storageClass !== "Standard")
      changed.push({
        path: "storageClass",
        old: "Standard",
        new: bucket.storageClass === "InfrequentAccess" ? bucket.storageClass : null,
      });
    if (managed.enabled) changed.push({ path: "publicAccess", old: "false", new: "true" });
    for (const [path, count] of [
      ["domains.count", domains.domains.length],
      ["cors.count", cors.rules?.length ?? 0],
      ["lifecycleRules.count", lifecycle.rules?.length ?? 0],
    ] as const)
      if (count) changed.push({ path, old: 0, new: count });
    if (changed.length)
      throw new BarrierRefusal("declared-bucket-policy-drift", fqn, {
        fqn,
        type: "Cloudflare.R2.Bucket",
        changed,
      });
    const location =
      bucket.location == null
        ? undefined
        : Schema.decodeUnknownSync(Schema.Literals(["apac", "eeur", "enam", "weur", "wnam", "oc"]))(
            bucket.location,
          );
    return {
      attributes: {
        ...target,
        location,
        domains: [],
        cors: [],
        lifecycleRules: [],
        publicDomain: undefined,
      },
      publicAccess: false,
    } satisfies BucketObservation;
  }).pipe(Effect.timeout("15 seconds"));

export const createDeclaredBucket = (target: BucketTarget) =>
  Effect.gen(function* () {
    yield* R2.createBucket({
      accountId: target.accountId,
      name: target.bucketName,
      jurisdiction: target.jurisdiction,
      storageClass: target.storageClass,
    }).pipe(Retry.none, Effect.timeout("15 seconds"));
  });

/** Called only after the create response and its native ownership journal are retained. */
export const configureDeclaredBucket = (target: BucketTarget) =>
  R2.putBucketLifecycle({
    accountId: target.accountId,
    bucketName: target.bucketName,
    jurisdiction: target.jurisdiction,
    rules: [],
  }).pipe(Retry.none, Effect.asVoid, Effect.timeout("15 seconds"));
