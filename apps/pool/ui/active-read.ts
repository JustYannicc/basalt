import { ChangeReadRetry, type ChangeActivity } from "apps/client";

/** Retained frames stay mounted; hiding one must cancel HTTP work as well as its change feed. */
export async function readWhileActive<T>(
  activity: ChangeActivity,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!activity.isActive()) throw new ChangeReadRetry("hidden");
  const controller = new AbortController();
  const stop = activity.onActiveChange((active) => {
    if (!active) controller.abort(new ChangeReadRetry("hidden"));
  });
  try {
    const value = await work(controller.signal);
    controller.signal.throwIfAborted();
    return value;
  } catch (error) {
    controller.signal.throwIfAborted();
    throw error;
  } finally {
    stop();
  }
}
