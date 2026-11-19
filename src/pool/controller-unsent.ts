/**
 * The controller's proof that no byte of a model call reached a runtime. Its value is the
 * controller's id for that attempt. Only the controller sets it, on a 503, and the pool Worker
 * strips it before any client sees the answer.
 */
export const controllerUnsentHeader = "X-Signalbox-Controller-Unsent";

/** Sent with the replay: the refused attempt's id, so the controller records both as one request. */
export const unsentAttemptHeader = "X-Signalbox-Unsent-Attempt";

const attemptId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The attempt id a header carries; a missing or malformed value carries none. */
export function unsentAttempt(value: string | null): string | undefined {
  return value !== null && attemptId.test(value) ? value : undefined;
}
