import { Effect, FileSystem, Layer, Path } from "effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { BearerTokenValidator, StateApi, StateAuthLive } from "alchemy/State/HttpStateApi";
import {
  makeReadOnlyBearerTokenValidator,
  READ_ONLY_GRANTS_STACK,
  readOnlyTokenId,
} from "alchemy/Cloudflare/StateStore/ReadOnlyAccess";

export const fullToken = "fixture-deployment-token-".repeat(3);
export const readerToken = "fixture-read-only-token-".repeat(3);
export const scope = { stack: "fixture", stage: "production" };
export const scopePath = `/state/stacks/${scope.stack}/stages/${scope.stage}`;

export async function stateApiFixture() {
  const stacks = new Map<
    string,
    Map<string, { resources: Map<string, unknown>; output?: unknown }>
  >();
  const stage = ({ stack, stage }: { stack: string; stage: string }) => {
    if (!stacks.has(stack)) stacks.set(stack, new Map());
    const stages = stacks.get(stack)!;
    if (!stages.has(stage)) stages.set(stage, { resources: new Map() });
    return stages.get(stage)!;
  };
  const writes: string[] = [];
  let version = 8;
  const write = <A>(name: string, update: () => A) =>
    Effect.sync(() => {
      writes.push(name);
      return update();
    });
  const handlers = HttpApiBuilder.group(StateApi, "state", (api) =>
    api
      .handle("listStacks", () => Effect.sync(() => [...stacks.keys()]))
      .handle("listStages", ({ params }) =>
        Effect.sync(() => [...(stacks.get(params.stack)?.keys() ?? [])]),
      )
      .handle("listResources", ({ params }) =>
        Effect.sync(() => [...stage(params).resources.keys()]),
      )
      .handle("getState", ({ params }) =>
        Effect.sync(() => stage(params).resources.get(decodeURIComponent(params.fqn))),
      )
      .handle("setState", ({ params, payload }) =>
        write("set", () => {
          stage(params).resources.set(decodeURIComponent(params.fqn), payload);
          return payload;
        }),
      )
      .handle("deleteState", ({ params }) =>
        write("delete", () => {
          stage(params).resources.delete(decodeURIComponent(params.fqn));
        }),
      )
      .handle("getReplacedResources", () => Effect.succeed([]))
      .handle("getStackOutput", ({ params }) => Effect.sync(() => stage(params).output))
      .handle("setStackOutput", ({ params, payload }) =>
        write("setOutput", () => (stage(params).output = payload)),
      )
      .handle("deleteStack", ({ params, query }) =>
        write("deleteStack", () => {
          if (query.stage) stacks.get(params.stack)?.delete(query.stage);
          else stacks.delete(params.stack);
        }),
      ),
  );
  const versions = HttpApiBuilder.group(StateApi, "version", (api) =>
    api.handle("getVersion", () => Effect.sync(() => ({ version }))),
  );
  const validator = makeReadOnlyBearerTokenValidator({
    validateFullAccess: (token) => Effect.succeed(token === fullToken),
    readGrant: (id) =>
      Effect.sync(() => stage({ stack: READ_ONLY_GRANTS_STACK, stage: id }).output),
  });
  const app = HttpApiBuilder.layer(StateApi).pipe(
    Layer.provide(handlers),
    Layer.provide(versions),
    Layer.provide(StateAuthLive),
    Layer.provide(Layer.succeed(BearerTokenValidator, validator)),
    Layer.provide([
      FileSystem.layerNoop({}),
      Etag.layer,
      Path.layer,
      Layer.succeed(HttpPlatform.HttpPlatform, {
        platform: "web",
        compression: {
          algorithms: new Set<HttpPlatform.CompressionAlgorithm>(),
          compressResponse: (response) => Effect.succeed(response),
        },
        fileResponse: () => Effect.die("Unexpected file response"),
        fileWebResponse: () => Effect.die("Unexpected file response"),
      }),
    ]),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
  const request = (method: string, path: string, token = fullToken, value?: unknown) =>
    handler(
      new Request(`https://state.example.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(value === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }),
      }),
    );
  const readerId = await Effect.runPromise(readOnlyTokenId(readerToken));
  const grantPath = `/state/stacks/${READ_ONLY_GRANTS_STACK}/stages/${readerId}`;
  return {
    handler,
    request,
    readerId,
    grantPath,
    writes,
    dispose,
    setVersion: (value: number) => {
      version = value;
    },
    provision: (grant = { version: 1, access: "read-only", ...scope }) =>
      request("PUT", `${grantPath}/output`, fullToken, grant),
    revoke: () => request("DELETE", `/state/stacks/${READ_ONLY_GRANTS_STACK}?stage=${readerId}`),
  };
}
