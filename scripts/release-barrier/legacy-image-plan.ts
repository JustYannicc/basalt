import type * as Plan from "alchemy/Plan";
import { Schema } from "effect";
import { retainedLegacyImage } from "../../src/pool/legacy-image.ts";
import { BarrierRefusal } from "./refusal.ts";

const preservesLegacy = Schema.is(
  Schema.Struct({ env: Schema.Struct({ POOL_PRESERVE_LEGACY_IMAGE: Schema.Literal("true") }) }),
);
const pin = (props: Record<string, unknown>, image: string) => ({
  ...Object.fromEntries(Object.entries(props).filter(([name]) => name !== "context")),
  image,
});

/** Pin during release planning, where native state is available, before any image is built or published. */
export function preserveLegacyPlan(plan: Plan.Plan) {
  if (!preservesLegacy(plan.resources.PoolWorker?.resource.Props)) return plan;
  const node = plan.resources.PoolContainer;
  if (!node || node.resource.Type !== "Cloudflare.Container")
    throw new BarrierRefusal("missing-legacy-container", "PoolContainer");
  if (!node.state || node.action !== "update") return plan;
  let retained;
  try {
    retained = retainedLegacyImage(node.state);
  } catch {
    throw new BarrierRefusal("container-baseline-input-unconfirmed", "PoolContainer");
  }
  if (!retained) throw new BarrierRefusal("container-baseline-input-unconfirmed", "PoolContainer");
  return {
    ...plan,
    resources: {
      ...plan.resources,
      PoolContainer: {
        ...node,
        props: pin(node.props, retained.image),
        resource: { ...node.resource, Props: pin(node.resource.Props, retained.image) },
      },
    },
  };
}
