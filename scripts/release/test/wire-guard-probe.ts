/**
 * Runs the wire guard self-test in a fresh process, the way a deploy does, and prints its outcome.
 * Modes: `installed` installs first; `missing` never installs; `late` sends one request through
 * FetchHttpClient before installing, which caches the global default the guard then cannot wrap.
 */
import { Cause, Effect, Exit } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { install, selfTest } from "../wire-guard.ts";

const [mode, base] = process.argv.slice(2) as [string, string];
const early = HttpClient.get(`${base}/accounts/early/workers/scripts`).pipe(
  Effect.provide(FetchHttpClient.layer),
  Effect.ignore,
);
const program = Effect.gen(function* () {
  if (mode === "late") yield* early;
  if (mode !== "missing") {
    const guard = yield* install();
    return yield* selfTest(base).pipe(Effect.provide(guard.layer));
  }
  return yield* selfTest(base);
}).pipe(Effect.scoped);

const exit = await Effect.runPromiseExit(program);
const error = Exit.isFailure(exit)
  ? (Cause.squash(exit.cause) as { _tag?: string; route?: string })
  : undefined;
process.stdout.write(
  JSON.stringify({ ok: Exit.isSuccess(exit), tag: error?._tag, route: error?.route }) + "\n",
);
