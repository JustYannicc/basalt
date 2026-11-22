import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { containerImages, type PlanResources } from "./container-image.ts";
import { buildContext, makePlan, pinnedImage, productionRows } from "./test/plan-fixture.ts";

const images = (plan: PlanResources) => Effect.runPromise(containerImages(plan));

test("a pinned root whose only change is its attachment says so", async (context) => {
  const { plan } = await makePlan(context, { rows: productionRows() });
  assert.equal(plan.resources.PoolContainer?.action, "update");
  assert.equal((await images(plan)).get("PoolContainer"), "attachment only");
});

test("a container built from a context other than the recorded one says its image changes", async (context) => {
  // State records the old context's image input; this checkout's context hashes differently.
  const { plan } = await makePlan(context, {
    rows: productionRows(),
    declared: { container: { context: buildContext } },
  });
  assert.equal(plan.resources.PoolContainer?.action, "update");
  assert.equal((await images(plan)).get("PoolContainer"), "image changes");
});

test("a moved pin is an image change, and what cannot be read is never attachment only", async () => {
  const node = (props: Record<string, unknown>, state: Record<string, unknown>) => ({
    resource: { Type: "Cloudflare.Container" },
    action: "update",
    props,
    state,
  });
  const read = await images({
    resources: {
      Moved: node({ image: `${pinnedImage}0` }, { props: { image: pinnedImage } }),
      Unread: node({ image: pinnedImage }, {}),
      Missing: node({ context: "/no/such/context" }, { attr: { hash: { image: "a".repeat(16) } } }),
      Unrecorded: node({ context: buildContext }, { attr: {} }),
      Kept: { ...node({ image: pinnedImage }, { props: { image: pinnedImage } }), action: "noop" },
      Worker: { resource: { Type: "Cloudflare.Worker" }, action: "update", props: {} },
    },
  });
  assert.deepEqual(Object.fromEntries(read), {
    Moved: "image changes",
    Unread: "image not known",
    Missing: "image not known",
    Unrecorded: "image not known",
  });
});
