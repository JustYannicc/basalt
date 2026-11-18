import type { ImageReleasePlan, RuntimeColor } from "../../src/pool/image-release-plan.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";

/** The image pins a release evaluates the stack with: native retained images, never new builds. */
export const releaseImagePlan = (
  record: Pick<RuntimeReleaseRecord, "baseline" | "update" | "desiredConfiguration">,
): ImageReleasePlan => ({
  ...(record.baseline.applications.legacy
    ? {
        legacy: {
          image: record.baseline.applications.legacy.image.image,
          props: record.baseline.applications.legacy.props,
        },
      }
    : {}),
  images: Object.fromEntries(
    (["blue", "green"] as const).flatMap((color) => {
      const application = record.baseline.applications[color];
      return application ? [[color, application.image.image]] : [];
    }),
  ),
  ...(record.update
    ? {
        candidateConfiguration: {
          applicationId: record.update.baseline.applicationId,
          configuration: record.desiredConfiguration,
        },
      }
    : {}),
});

/** A missing fleet color is first declared on the root's retained image. */
export const bootstrapImagePlan = (
  record: RuntimeReleaseRecord,
  color: RuntimeColor,
): ImageReleasePlan => {
  const plan = releaseImagePlan(record);
  return {
    ...plan,
    images: { ...plan.images, [color]: record.baseline.applications.root.image.image },
  };
};
