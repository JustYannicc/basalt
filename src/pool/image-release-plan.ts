import { Context } from "effect";
import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import { hashDockerBuildInputs } from "alchemy/Docker/BuildHash";
import { sha256Object } from "alchemy/Util/sha256";
import type { RuntimeConfiguration } from "./runtime-slots/configuration.ts";

export type RuntimeColor = "blue" | "green";
export interface ImageReleasePlan {
  readonly images: Partial<Record<RuntimeColor, string>>;
  readonly build?: RuntimeColor;
  readonly legacy?: { image: string; props: Record<string, unknown> };
  readonly candidateConfiguration?: { applicationId: string; configuration: RuntimeConfiguration };
}

/** The release writer supplies this plan; ordinary configuration keeps its explicit immutable pins. */
export const RuntimeImageReleasePlan = Context.Reference<ImageReleasePlan | undefined>(
  "basalt/RuntimeImageReleasePlan",
  { defaultValue: () => undefined },
);

/** Use the same effective context and repository identity as the pinned container provider. */
export const desiredPoolImageInput = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem,
    path = yield* Path.Path;
  const context = yield* fs.realPath(
    fileURLToPath(new URL("../../containers/pool/", import.meta.url)),
  );
  const contextHash = yield* hashDockerBuildInputs(
    { context, dockerfile: path.join(context, "Dockerfile"), platform: "linux/amd64" },
    "effective",
  );
  return (yield* sha256Object({ contextHash, imageName: undefined })).slice(0, 16);
});
