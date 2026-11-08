import {
  createApp,
  InMemoryFileSystem,
} from "../../.upstream/packages/sdk/node_modules/@cloudflare/worker-bundler/dist/index.js";
import { Effect, Path } from "../../.upstream/packages/sdk/node_modules/effect/dist/index.js";
import {
  HttpServerRequest,
  HttpServerResponse,
} from "../../.upstream/packages/sdk/node_modules/effect/dist/http/index.js";
import { browserBuild } from "../../.upstream/packages/sdk/src/implementation/worker-browser-build.ts";
import { prepareUiBuild } from "../../.upstream/packages/sdk/src/implementation/ui-build.ts";
import { sourceImports } from "../../.upstream/packages/sdk/src/implementation/worker-source-imports.ts";
import { binaryFilePaths } from "../../.upstream/packages/sdk/src/implementation/worker-binary-files.ts";
import { appAsset, appDocument } from "../../.upstream/packages/apps/src/ui-serving.ts";

const version = "a".repeat(64);
let assets = [];
export default {
  async fetch(request) {
    try {
      if (request.method !== "POST") {
        const path = new URL(request.url).pathname;
        const response =
          path === "/"
            ? appDocument({
                version,
                asset: (name) => Effect.succeed(assets.find((asset) => asset.path === name)),
              })
            : appAsset(
                assets.find((asset) => asset.path === path.split("/").at(-1)),
                version,
                path.split("/").at(-1),
              );
        return HttpServerResponse.toWeb(
          await Effect.runPromise(
            response.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                HttpServerRequest.fromWeb(request),
              ),
            ),
          ),
        );
      }
      const { files, dependency } = await request.json();
      const filesystem = new InMemoryFileSystem(
        Object.fromEntries(files.map((file) => [file.path, file.content])),
      );
      for (const [path, content] of Object.entries(dependency))
        filesystem.write(
          path,
          typeof content === "string" ? content : { data: new Uint8Array(content) },
        );
      filesystem.write(
        "proof-server.ts",
        'export default {fetch(){return new Response("compiler fixture")}}',
      );
      const plan = await Effect.runPromise(prepareUiBuild(files, ["fonts.css"]));
      const browser = await Effect.runPromise(browserBuild(files, filesystem, plan, {}));
      const path = await Effect.runPromise(Path.Path.pipe(Effect.provide(Path.layer)));
      await createApp({
        files: binaryFilePaths(filesystem),
        server: "proof-server.ts",
        client: plan.entries,
        installDependencies: false,
        __dangerouslyUseEsBuildPluginsDoNotUseOrYouWillBeFired: [
          browser.plugin,
          sourceImports(filesystem, path),
        ],
      });
      assets = await Effect.runPromise(browser.finish());
      return Response.json({
        assets: assets.map((asset) => ({ ...asset, body: [...asset.body] })),
      });
    } catch (error) {
      return new Response(String(error), { status: 500 });
    }
  },
};
