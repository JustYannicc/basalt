/**
 * A test stage's destroy empties and deletes only a bucket Alchemy named for that stage: its
 * recorded name must be the one this stack and stage give the resource, rebuilt from the row's own
 * id and instance. Upstream's cleanup admits buckets by upstream's stack name, so it refused every
 * Basalt bucket and each stage's destroy stopped there. Production's buckets never pass: their
 * name, or the hash a truncated name keeps, is built from production's stage.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";

type BucketProvider = Provider.ProviderService<Cloudflare.R2.Bucket>;
type DeleteInput = Parameters<BucketProvider["delete"]>[0];

/** The name Alchemy's bucket provider creates for a resource with no explicit name. */
export const stageBucketName = (id: string, instanceId: string) =>
  createPhysicalName({ id, instanceId, maxLength: 63 }).pipe(
    Effect.map((name) => name.toLowerCase()),
  );

export const stageBucketDelete = (native: BucketProvider) => (input: DeleteInput) =>
  Effect.gen(function* () {
    const stage = yield* Stage;
    const own = yield* stageBucketName(input.id, input.instanceId);
    if (!stage.startsWith("test-") || input.olds?.name || input.output.bucketName !== own)
      return yield* Effect.die(new Error("Refusing to empty a bucket this stage did not name."));
    yield* native.delete({ ...input, olds: { ...input.olds, forceDestroy: true } });
  });

/** Takes the place of upstream's `TestStageBucketCleanup` in a cleanup stack. */
export const StageBucketCleanup = () =>
  Provider.effect(
    Cloudflare.R2.Bucket,
    Effect.gen(function* () {
      const native = yield* Provider.findProvider(Cloudflare.R2.Bucket);
      return { ...native, delete: stageBucketDelete(native) };
    }).pipe(Effect.provide(Cloudflare.providers())),
  );
