import type { StateService } from "alchemy/State/State";
import { Effect, Schema } from "effect";
import { retainedRuntimeImage } from "../../src/pool/legacy-image.ts";
import { BarrierRefusal } from "./refusal.ts";

/** The account and PoolWorker script a fleet command is sent to. */
export type ReleaseTarget = { accountId: string; worker: string };
/** The root PoolContainer application a legacy slot witness names. */
export type RootApplication = {
  applicationId: string;
  applicationVersion: string;
  imageDigest: string;
  imageInput: string;
};

const Worker = Schema.Struct({
  status: Schema.Literals(["created", "updated"]),
  resourceType: Schema.Literal("Cloudflare.Worker"),
  attr: Schema.Struct({ accountId: Schema.NonEmptyString, workerName: Schema.NonEmptyString }),
  props: Schema.Struct({
    env: Schema.Struct({
      POOL_IMAGE_HASH: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u)),
    }),
  }),
});
const Root = Schema.Struct({
  status: Schema.Literals(["created", "updated"]),
  resourceType: Schema.Literal("Cloudflare.Container"),
  attr: Schema.Struct({
    accountId: Schema.NonEmptyString,
    applicationId: Schema.NonEmptyString,
    version: Schema.Number,
    configuration: Schema.Struct({ image: Schema.NonEmptyString }),
  }),
});

/**
 * PoolWorker's target and the root application, from the stack's recorded State rows. The image
 * input is PoolWorker's POOL_IMAGE_HASH, the identity the controller reports for the root: with a
 * pinned root, Alchemy's own hash.image names the reference, not the build.
 */
export const releaseTargetFromState = (state: StateService, stack: string, stage: string) =>
  Effect.gen(function* () {
    const read = (fqn: string) => state.get({ stack, stage, fqn });
    const worker = Schema.decodeUnknownOption(Worker)(yield* read("PoolWorker"));
    if (worker._tag === "None")
      return yield* Effect.die(new BarrierRefusal("release-target-worker-unsettled", "PoolWorker"));
    const row = yield* read("PoolContainer");
    const root = Schema.decodeUnknownOption(Root)(row);
    let image;
    try {
      image = retainedRuntimeImage(row, "PoolContainer");
    } catch {
      image = undefined;
    }
    if (!image || root._tag === "None" || root.value.attr.accountId !== worker.value.attr.accountId)
      return yield* Effect.die(
        new BarrierRefusal("release-target-root-unsettled", "PoolContainer"),
      );
    return {
      accountId: worker.value.attr.accountId,
      worker: worker.value.attr.workerName,
      root: {
        applicationId: root.value.attr.applicationId,
        applicationVersion: String(root.value.attr.version),
        imageDigest: image.digest,
        imageInput: worker.value.props.env.POOL_IMAGE_HASH,
      } satisfies RootApplication,
    } satisfies ReleaseTarget & { root: RootApplication };
  });

/** Every State mutation fails before it reaches the backing store. */
export function readOnlyState(state: StateService): StateService {
  const refused = () => Effect.die(new BarrierRefusal("release-target-state-write-refused"));
  return {
    ...state,
    set: refused,
    delete: refused,
    deleteStack: refused,
    setOutput: refused,
  };
}

/** State authentication uses temporary preview uploads; any other non-GET request is refused. */
export function readOnlyFetch(accountId: string, nativeFetch = globalThis.fetch): typeof fetch {
  const prefix = `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/`;
  const preview = new Set([
    `${prefix}subdomain/edge-preview`,
    `${prefix}scripts/alchemy-state-store/edge-preview`,
  ]);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      request.method !== "GET" &&
      !(
        request.method === "POST" &&
        url.origin === "https://api.cloudflare.com" &&
        preview.has(url.pathname)
      )
    )
      throw new BarrierRefusal("release-target-mutation-refused");
    return nativeFetch(
      new Request(request, {
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      }),
    );
  };
}
