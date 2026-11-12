import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  Effect,
  Layer,
} from "../../../.upstream/apps/hosted/cloud/node_modules/effect/src/index.ts";
import * as NodeServices from "../../../.upstream/apps/hosted/cloud/node_modules/@effect/platform-node/src/NodeServices.ts";
import {
  Docker,
  DockerLive,
} from "../../../.upstream/apps/hosted/cloud/node_modules/alchemy/src/Docker/Docker.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = resolve(process.env.DENSITY_OUTPUT ?? root + ".local/density");
const source = "53d3a3730859fd2b46f435cdaaa6ffedaf73400b";
const tree = (revision) =>
  execFileSync("git", ["rev-parse", `${revision}:containers/pool`], {
    cwd: root,
    encoding: "utf8",
  }).trim();
if (tree("HEAD") !== tree(source))
  throw Error("Container source differs from the frozen candidate");
if (process.arch !== "x64") throw Error("Density image requires a native x86 runner");
mkdirSync(out, { recursive: true });
const tag = "pool-density-x86:local";
const program = Effect.gen(function* () {
  const docker = yield* Docker;
  const result = yield* docker.image.build(
    {
      context: root + "containers/pool",
      file: root + "containers/pool/Dockerfile",
      platform: "linux/amd64",
      tag,
    },
    {
      note: (message) =>
        Effect.sync(() => appendFileSync(out + "/image-build.log", message + "\n")),
    },
  );
  if (Number(result.exitCode) !== 0) throw Error("Frozen image build failed");
  const image = yield* docker.image.inspect(tag);
  writeFileSync(out + "/image-inspection.json", JSON.stringify(image, null, 2) + "\n");
  writeFileSync(out + "/image.id", image.Id + "\n");
  writeFileSync(
    out + "/image-source.json",
    JSON.stringify(
      { source, tree: tree(source), platform: "linux/amd64", registryPush: false },
      null,
      2,
    ) + "\n",
  );
});
await Effect.runPromise(
  program.pipe(Effect.provide(DockerLive.pipe(Layer.provide(NodeServices.layer)))),
);
