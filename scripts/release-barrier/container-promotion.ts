import { Config, Effect, Redacted, Schema } from "effect";
import {
  cloudflareResult,
  encodePathSegment,
  withBearer,
  type Fetcher,
} from "../deploy-safety/http.ts";
import { BarrierRefusal } from "./manifest.ts";
import type { ContainerRollout } from "./container-cloudflare.ts";
import type { ContainerSnapshot } from "./container.ts";

const rolloutState = Schema.Struct({
  id: Schema.String,
  current_version: Schema.Number,
  target_version: Schema.Number,
  kind: Schema.Literal("full_manual"),
  status: Schema.Literals(["pending", "progressing", "completed"]),
});

const rolloutRequest = (
  target: Pick<ContainerSnapshot, "accountId" | "applicationId">,
  rollout: ContainerRollout,
  method: "GET" | "POST",
  fetcher: Fetcher,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetcher(
          `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(target.accountId)}/containers/applications/${encodePathSegment(target.applicationId)}/rollouts/${encodePathSegment(rollout.id)}`,
          {
            method,
            redirect: "error",
            headers: {
              ...withBearer(Redacted.value(token)),
              ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
            },
            ...(method === "POST" ? { body: JSON.stringify({ action: "next" }) } : {}),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new Error();
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2_000_000) throw new Error();
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        return cloudflareResult(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          "container rollout",
        ).result;
      },
      catch: () => new BarrierRefusal("container-promotion-unconfirmed"),
    });
  });

export const readManualRollout = (
  target: ContainerSnapshot,
  rollout: ContainerRollout,
  fetcher: Fetcher = fetch,
) =>
  rolloutRequest(target, rollout, "GET", fetcher).pipe(
    Effect.map((value) => {
      try {
        const state = Schema.decodeUnknownSync(rolloutState)(value);
        if (
          state.id !== rollout.id ||
          state.current_version !== rollout.currentVersion ||
          state.target_version !== rollout.targetVersion
        )
          throw new Error();
        return state;
      } catch {
        throw new BarrierRefusal("container-promotion-state-drift");
      }
    }),
  );

/** One singleton step is explicitly advanced once. Lost responses are observed, never retried. */
export const advanceContainer = (
  target: ContainerSnapshot,
  rollout: ContainerRollout,
  fetcher: Fetcher = fetch,
) =>
  Effect.gen(function* () {
    const before = yield* readManualRollout(target, rollout, fetcher);
    if (before.status !== "pending") throw new BarrierRefusal("container-promotion-state-drift");
    yield* rolloutRequest(target, rollout, "POST", fetcher);
    const after = yield* readManualRollout(target, rollout, fetcher);
    if (after.status === "pending") throw new BarrierRefusal("container-promotion-unconfirmed");
  });

export const observeContainerPromotion = (
  target: ContainerSnapshot,
  rollout: ContainerRollout,
  fetcher: Fetcher = fetch,
) =>
  readManualRollout(target, rollout, fetcher).pipe(
    Effect.flatMap((state) =>
      state.status === "pending"
        ? Effect.fail(new BarrierRefusal("container-recovery-promotion-unconfirmed"))
        : Effect.void,
    ),
  );
