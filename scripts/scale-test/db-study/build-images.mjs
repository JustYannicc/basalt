import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
  rmSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  Effect,
  Layer,
} from "../../../.upstream/apps/hosted/cloud/node_modules/effect/src/index.ts";
import * as NodeServices from "../../../.upstream/apps/hosted/cloud/node_modules/@effect/platform-node/src/NodeServices.ts";
import {
  Docker,
  DockerLive,
} from "../../../.upstream/apps/hosted/cloud/node_modules/alchemy/src/Docker/Docker.ts";
const root = fileURLToPath(new URL("../../../", import.meta.url)),
  own = fileURLToPath(new URL(".", import.meta.url));
const out = process.env.DENSITY_OUTPUT;
if (!out || process.arch !== "x64") throw Error("Native x86 study output required");
mkdirSync(out, { recursive: true });
const source = "53d3a3730859fd2b46f435cdaaa6ffedaf73400b";
const kind = process.argv[2];
if (!["release", "profile"].includes(kind))
  throw Error("Explicit release or diagnostic profile image required");
const context = join(out, "context");
mkdirSync(context, { recursive: false });
const archive = execFileSync("git", ["archive", source, "containers/pool"], {
  cwd: root,
  maxBuffer: 32 * 2 ** 20,
});
execFileSync("tar", ["-x", "-f", "-", "--strip-components=2", "-C", context], { input: archive });
const sha = (data) => createHash("sha256").update(data).digest("hex");
writeFileSync(
  join(out, "source.json"),
  JSON.stringify(
    {
      source,
      containerTree: execFileSync("git", ["rev-parse", source + ":containers/pool"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      archiveSHA256: sha(archive),
      platform: "linux/amd64",
      registryPush: false,
      harnessHead: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      fixtureSources: Object.fromEntries(
        readdirSync(own, { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => [entry.name, sha(readFileSync(join(own, entry.name)))]),
      ),
      releaseDockerfileSHA256: sha(readFileSync(join(context, "Dockerfile"))),
    },
    null,
    2,
  ) + "\n",
);
const program = Effect.gen(function* () {
  const docker = yield* Docker;
  {
    if (kind === "profile") {
      mkdirSync(join(context, "db-study-fixture"));
      for (const name of ["instrument-sql.py", "sql-fixture-trace.go.tmpl"])
        cpSync(join(own, name), join(context, "db-study-fixture", name));
      const extra = `\nFROM source-build AS sql-profile-build\nRUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*\nCOPY db-study-fixture /fixture\nRUN python3 /fixture/instrument-sql.py /usr/local/go /fixture/sql-fixture-trace.go.tmpl > /out/sql-instrumentation.json\nRUN cd /source/home && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -p=2 -mod=readonly -buildvcs=false -ldflags="-s -w -X main.Version=$(cat .build-version) -X main.Commit=$(cat .build-commit)" -o /out/home-profile ./cmd/home\nRUN cd /source/node && CGO_ENABLED=1 GOOS=linux GOARCH=amd64 go build -p=2 -mod=readonly -buildvcs=false -ldflags="-s -w -X main.Version=$(cat .build-version) -X main.Commit=$(cat .build-commit)" -o /out/node-profile ./cmd/server\nRUN cd /source/gemini-cli && CGO_ENABLED=1 go build -p=2 -mod=readonly -trimpath -buildmode=c-shared -ldflags="-s -w -X main.pluginVersion=$(cat .build-version)" -o /out/plugins/gemini-cli.so ./cmd/geminicli && cd /build/typesafe && CGO_ENABLED=1 go build -p=2 -mod=readonly -trimpath -buildmode=c-shared -ldflags="-s -w" -o /out/plugins/typesafe.so . && cd /build/native_policy && CGO_ENABLED=1 go build -p=2 -mod=readonly -buildmode=c-shared -o /out/plugins/basalt-native-policy.so .\nFROM runtime AS sql-profile-runtime\nCOPY --from=sql-profile-build /out/home-profile /usr/local/bin/cliproxy-home\nCOPY --from=sql-profile-build /out/node-profile /usr/local/bin/cliproxy-node\nCOPY --from=sql-profile-build /out/plugins /opt/pool/plugins\nCOPY --from=sql-profile-build /out/sql-instrumentation.json /fixture/sql-instrumentation.json\nCOPY --from=sql-profile-build /source/home /fixture/home-source\n`;
      writeFileSync(
        join(context, "Dockerfile"),
        readFileSync(join(context, "Dockerfile"), "utf8") + extra,
      );
    }
    const tag = "pool-db-study:" + kind;
    const result = yield* docker.image.build(
      {
        context,
        file: join(context, "Dockerfile"),
        platform: "linux/amd64",
        tag,
      },
      {
        note: (message) =>
          Effect.sync(() => appendFileSync(join(out, "image-build.log"), message + "\n")),
      },
    );
    if (Number(result.exitCode) !== 0) throw Error("Study image build failed: " + kind);
    const image = yield* docker.image.inspect(tag);
    writeFileSync(join(out, kind + "-image.json"), JSON.stringify(image, null, 2) + "\n");
    writeFileSync(join(out, kind + "-image.id"), image.Id + "\n");
  }
});
await Effect.runPromise(
  program.pipe(Effect.provide(DockerLive.pipe(Layer.provide(NodeServices.layer)))),
);
rmSync(context, { recursive: true });
