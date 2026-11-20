import { Effect, FileSystem, Path } from "effect";
import { fileURLToPath } from "node:url";
import { hashDockerBuildInputs } from "alchemy/Docker/BuildHash";
import { sha256Object } from "alchemy/Util/sha256";

export type RuntimeColor = "blue" | "green";

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
