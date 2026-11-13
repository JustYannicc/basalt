import type { CompiledStack } from "alchemy/Stack";
import { Effect, Redacted, Schema } from "effect";
import { runtimeConfiguration } from "../../src/pool/runtime-slots/configuration.ts";
import { desiredPoolImageInput } from "../../src/pool/image-release-plan.ts";
import { planStack } from "./plan-stack.ts";
import { BarrierRefusal } from "./refusal.ts";

/** Capture the candidate's settings before the code phase preserves the old process's inputs. */
export const runtimeReleaseDesired = (stack: CompiledStack) =>
  Effect.gen(function* () {
    const plan = yield* planStack(stack);
    const node = plan.resources.PoolWorker;
    if (!node) throw new BarrierRefusal("runtime-release-desired-Worker-missing", "PoolWorker");
    const { env } = Schema.decodeUnknownSync(
      Schema.Struct({ env: Schema.Record(Schema.String, Schema.Unknown) }),
    )("props" in node ? node.props : node.state?.props);
    const setting = (name: string, optional = false) => {
      const raw = env[name],
        value = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      if (typeof value === "string" && value) return value;
      if (optional && value === undefined) return undefined;
      throw new BarrierRefusal(
        "runtime-release-desired-setting-unavailable",
        `PoolWorker.env.${name}`,
      );
    };
    const imageInput = yield* desiredPoolImageInput;
    const configuration = runtimeConfiguration({
      POOL_DATABASE_URL: setting("POOL_DATABASE_URL")!,
      POOL_MANAGEMENT_KEY: setting("POOL_MANAGEMENT_KEY")!,
      POOL_APP_SIGNING_KEY: setting("POOL_APP_SIGNING_KEY")!,
      POOL_APP_SIGNING_KEY_PREVIOUS: setting("POOL_APP_SIGNING_KEY_PREVIOUS", true),
      POOL_CLAUDE_QUOTA_DIAGNOSTIC: setting("POOL_CLAUDE_QUOTA_DIAGNOSTIC", true),
      POOL_IMAGE_HASH: imageInput,
    });
    return { imageInput, configuration };
  });
