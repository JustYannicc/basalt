import type { Worker } from "alchemy/Cloudflare";
import type { ResourceBinding } from "alchemy/Resource";
import { Schema } from "effect";

const hasEnvironmentBindings = Schema.is(
  Schema.Struct({
    bindings: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String }))),
    env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);

/** Alchemy lowers resource env values to bindings; refreshed attributes are not upload inputs. */
export function workerActivationInputs(
  news: Worker["Props"],
  bindings: readonly ResourceBinding<unknown>[],
) {
  const lowered = new Set(
    bindings.flatMap(({ data }) =>
      hasEnvironmentBindings(data)
        ? [...(data.bindings ?? []).map(({ name }) => name), ...Object.keys(data.env ?? {})]
        : [],
    ),
  );
  return {
    news: {
      ...news,
      env: Object.fromEntries(
        Object.entries(news.env ?? {}).filter(([name]) => !lowered.has(name)),
      ),
    },
    bindings,
  };
}
