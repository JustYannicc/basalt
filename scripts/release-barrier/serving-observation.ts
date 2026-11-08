import { Schema } from "effect";
import { bounded } from "../database-budget-readiness.ts";
import { encodePathSegment, type Fetcher } from "../deploy-safety/http.ts";
import { ServingFailure, servingFailure, type ServingCheck } from "./serving-failure.ts";

const state = Schema.Literals([
  "provisioning",
  "running",
  "failed",
  "stopping",
  "stopped",
  "unhealthy",
  "inactive",
  "unknown",
]);
const application = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  version: Schema.Number,
  active_rollout_id: Schema.optional(Schema.NullOr(Schema.String)),
  configuration: Schema.Struct({ image: Schema.String }),
});
const instances = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    application_id: Schema.String,
    image: Schema.String,
    started_at: Schema.optional(Schema.String),
    status: Schema.Struct({ state }),
  }),
);
const envelope = Schema.Struct({
  success: Schema.Literal(true),
  errors: Schema.Array(Schema.Unknown),
  result: Schema.Unknown,
  result_info: Schema.optional(Schema.Struct({ next_page_token: Schema.optional(Schema.String) })),
});
const digest = (image: string) => /@(sha256:[a-f0-9]{64})$/u.exec(image)?.[1] ?? null;
const identifier = (value: string) =>
  /^[a-f0-9]{64}$/u.test(value) || /^[a-f0-9-]{36}$/u.test(value);

export interface ServingTarget {
  accountId: string;
  applicationId: string;
  version: number;
  digest: string;
}

/** Only projected application and placement metadata leaves this read-only adapter. */
export async function readServingObservation(
  target: ServingTarget,
  token: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetch,
) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(target.accountId)}/containers/applications/${encodePathSegment(target.applicationId)}`;
  const read = async (url: string, check: ServingCheck) => {
    try {
      const response = await bounded(
        fetcher(url, {
          method: "GET",
          redirect: "error",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        }),
        signal,
      );
      if (response.status !== 200) {
        await bounded(response.body?.cancel() ?? Promise.resolve(), signal);
        throw new ServingFailure({
          check,
          cause: "http-status",
          status: response.status,
          expectedStatus: 200,
        });
      }
      const text = await bounded(response.text(), signal);
      if (text.length > 2_000_000) throw new ServingFailure({ check, cause: "response-too-large" });
      const reply = Schema.decodeUnknownSync(envelope)(JSON.parse(text));
      if (reply.errors.length) throw new ServingFailure({ check, cause: "provider-errors" });
      return reply;
    } catch (error) {
      throw servingFailure(check, error);
    }
  };
  const appReply = await read(base, "application-image");
  let app: typeof application.Type;
  try {
    app = Schema.decodeUnknownSync(application)(appReply.result);
  } catch (error) {
    throw servingFailure("application-image", error);
  }
  if (
    app.id !== target.applicationId ||
    app.account_id !== target.accountId ||
    !Number.isSafeInteger(app.version) ||
    app.version < 1 ||
    (app.active_rollout_id && !identifier(app.active_rollout_id))
  )
    throw new ServingFailure({ check: "application-image", cause: "target-invalid" });
  const placements: {
    id: string;
    state: typeof state.Type;
    digest: string | null;
    startedAt: number | null;
  }[] = [];
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ state: "active", per_page: "100" });
    if (pageToken) query.set("page_token", pageToken);
    const reply = await read(`${base}/instances-v2?${query}`, "instance-image");
    let values: typeof instances.Type;
    try {
      values = Schema.decodeUnknownSync(instances)(reply.result);
    } catch (error) {
      throw servingFailure("instance-image", error);
    }
    for (const item of values) {
      if (
        !/^[a-f0-9]{64}$/u.test(item.id) ||
        ids.has(item.id) ||
        item.application_id !== target.applicationId
      )
        throw new ServingFailure({ check: "instance-image", cause: "target-invalid" });
      ids.add(item.id);
      const startedAt = item.started_at === undefined ? null : Date.parse(item.started_at);
      if (startedAt !== null && !Number.isSafeInteger(startedAt))
        throw new ServingFailure({ check: "instance-image", cause: "invalid-start-time" });
      placements.push({
        id: item.id,
        state: item.status.state,
        digest: digest(item.image),
        startedAt,
      });
    }
    const next = reply.result_info?.next_page_token;
    if (!next)
      return {
        version: app.version,
        ...(app.active_rollout_id ? { activeRolloutId: app.active_rollout_id } : {}),
        digest: digest(app.configuration.image),
        instances: placements,
      };
    if (tokens.has(next))
      throw new ServingFailure({ check: "instance-image", cause: "pagination-cycle" });
    tokens.add(next);
    pageToken = next;
  }
  throw new ServingFailure({ check: "instance-image", cause: "pagination-limit" });
}
