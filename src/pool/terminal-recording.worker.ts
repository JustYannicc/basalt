import { captureError } from "../telemetry/sentry.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { withHistoryDatabase } from "./model-history/database.ts";
import { recordTerminalStart, recordTerminalFinish } from "./model-history/terminal.ts";
import type { RefusalIdentity } from "./gateway-failure.ts";
import type { TerminalOutcome } from "./terminal-protocol.ts";

export interface TerminalStart extends RefusalIdentity {
  requestId: string;
  at: string;
  pathname: string;
}
export interface TerminalFinish {
  outcome: TerminalOutcome;
  status: number;
  bytes: number;
  at: string;
}
export interface TerminalRecorder {
  start(input: TerminalStart): Promise<void>;
  finish(requestId: string, result: TerminalFinish): Promise<void>;
}
interface Environment extends SentryEnv {
  POOL_MODEL_HISTORY_ENABLED?: string;
  POOL_AUTH_DATABASE?: { connectionString: string };
}

/** A failed evidence write is visible without interrupting or retrying the model request. */
export function requestTerminal(
  env: Environment,
  requestId: string,
  pathname: string,
  identity: () => Promise<RefusalIdentity | undefined>,
  defer: (work: Promise<unknown>) => void,
  recorder?: TerminalRecorder,
) {
  if (!recorder && env.POOL_MODEL_HISTORY_ENABLED !== "true") return undefined;
  const store = recorder ?? {
    start: (input: TerminalStart) =>
      withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) =>
        recordTerminalStart(db, input),
      ),
    finish: (id: string, result: TerminalFinish) =>
      withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) =>
        recordTerminalFinish(db, id, result),
      ),
  };
  const startedAt = new Date().toISOString();
  const started = (async () => {
    const caller = await identity();
    if (!caller) throw new Error("Terminal identity unavailable");
    await store.start({ ...caller, requestId, pathname, at: startedAt });
  })();
  let finished = false;
  let reported = false;
  const failed = async () => {
    if (reported) return;
    reported = true;
    console.error("POOL_TERMINAL_COLLECTION_UNAVAILABLE", { requestId });
    await captureError(env, "pool_terminal_collection_unavailable", pathname, undefined, requestId);
  };
  // Register dispatch evidence with waitUntil before a client can abandon the stream.
  defer(started.catch(failed));
  return (outcome: TerminalOutcome, status: number, bytes: number) => {
    if (finished) return;
    finished = true;
    const finishedAt = new Date().toISOString();
    defer(
      started
        .then(() => store.finish(requestId, { outcome, status, bytes, at: finishedAt }))
        .catch(failed),
    );
    if (outcome !== "complete")
      console.error("POOL_REQUEST_TERMINAL", { requestId, outcome, status, bytes });
    if (outcome !== "complete")
      defer(
        captureError(
          env,
          outcome === "unavailable"
            ? "pool_terminal_collection_unavailable"
            : "pool_terminal_failure",
          pathname,
          undefined,
          requestId,
        ),
      );
  };
}
