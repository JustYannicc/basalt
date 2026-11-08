import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Context, Effect, Layer, Schedule } from "effect";
import { Telemetry } from "../.upstream/e2e/support/evidence.ts";
import { Target } from "../.upstream/e2e/support/platform.ts";
import { controlRequest } from "../.upstream/e2e/support/server-control.ts";

/** Check delivered transport spans and deterministic expiry through the isolated product. */
export const proveZohoMcpPrivacy = ({
  api,
  session,
  target,
  path,
  prefix,
  account,
  endpoint,
  request,
  response,
  directory,
  check,
}) =>
  Effect.gen(function* () {
    const trace = randomBytes(16).toString("hex");
    const called = yield* api.request(
      session,
      "POST",
      `${path}/tools/call`,
      {
        tool: "mcp.readPeople",
        input: { accountId: account.id, input: {} },
      },
      { traceparent: `00-${trace}-${randomBytes(8).toString("hex")}-01` },
    );
    check("traced MCP read completes", called.status, 200);
    const services = yield* Layer.build(
      Telemetry.layer.pipe(Layer.provideMerge(Layer.succeed(Target, target))),
    );
    const telemetry = Context.get(services, Telemetry);
    const delivered = yield* telemetry.query(trace).pipe(
      Effect.flatMap((result) =>
        result.data.some(({ span }) => span.operationName.startsWith("provider.mcp."))
          ? Effect.succeed(result)
          : Effect.fail(new Error("MCP transport span has not been delivered")),
      ),
      Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 80 }),
    );
    check("actual MCP transport spans were delivered", delivered.data.length > 0, true);
    const logs = yield* telemetry.logs(trace, "synthetic-people-endpoint-marker");
    const collectors = yield* Effect.promise(() =>
      Promise.all(
        [
          "server.log",
          "telemetry-relay.ndjson",
          "sentry.ndjson",
          "analytics.ndjson",
          "flags.ndjson",
        ].map(async (file) => ({
          file,
          text: await readFile(join(target.directory, file), "utf8"),
        })),
      ),
    );
    const text = JSON.stringify({ delivered, logs, collectors });
    for (const marker of ["synthetic-people-endpoint-marker", "synthetic-private-query-marker"])
      check("private URL absent from delivered traces and logs", text.includes(marker), false);
    yield* Effect.promise(() =>
      writeFile(join(directory, "transport-trace.json"), JSON.stringify(delivered, null, 2)),
    );

    const pending = yield* request("POST", `${path}/accounts/user/people/connections`, {});
    yield* request("POST", `${prefix}/connections/${pending.id}/mcp-endpoint`, {
      method: "mcp",
      endpoint,
    });
    yield* controlRequest("clock/advance", 200, { milliseconds: 31 * 60_000 }).pipe(
      Effect.provideService(Target, target),
    );
    const expired = yield* request("GET", `${prefix}/connections/${pending.id}`);
    check("private pending connection expires", expired.state.status, "expired");
    check("expired connection drops its endpoint binding", expired.mcpEndpointMethod, undefined);
    check(
      "expired endpoint cannot start OAuth",
      (yield* response("POST", `${prefix}/connections/${pending.id}/oauth/start`, {
        method: "mcp",
      })).status >= 400,
      true,
    );
  });
