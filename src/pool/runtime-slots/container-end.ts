import { Schema } from "effect";

/**
 * How a runtime container last ended, as closed values only: never the platform's message text.
 * The platform hands an exit only to the `monitor()` of an object instance that attached it:
 * resolve is exit 0; a rejection carries the exit code and names an unexpected exit, a runtime
 * signal or a version rollout; "no container instance" means it never ran. A destroy and a kill
 * both read as 137, so `stopSent` says whether the stop was ours.
 */
export const RuntimeEnd = Schema.Struct({
  at: Schema.Number,
  exitCode: Schema.NullOr(Schema.Number),
  cause: Schema.Literals(["exit", "signal", "rollout", "no_instance", "unknown"]),
  seen: Schema.Literals(["monitor", "found_stopped"]),
  stopSent: Schema.optional(Schema.Literal(true)),
});
export type RuntimeEnd = typeof RuntimeEnd.Type;

const key = "runtime-container-end-v1";
const Boot = Schema.Struct({
  startedAt: Schema.Number,
  stopSentAt: Schema.optional(Schema.Number),
  end: Schema.optional(RuntimeEnd),
});
const EndRecord = Schema.Struct({ current: Boot, previous: Schema.optional(RuntimeEnd) });
type EndRecord = typeof EndRecord.Type;
const isEndRecord = Schema.is(EndRecord);
const hasExitCode = Schema.is(Schema.Struct({ exitCode: Schema.Number }));

interface Container {
  readonly running: boolean;
  monitor(): Promise<void>;
}
interface Storage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<unknown>;
}

/** The boot each container's monitor watches in this isolate, so one instance attaches once. */
const watching = new WeakMap<object, number>();

/** What a settled monitor handed over. A rejection that isn't an exit leaves the cause unknown. */
export function classifyEnd(
  outcome: { readonly resolved: true } | { readonly error: unknown },
  at: number,
  stopSent: boolean,
): RuntimeEnd {
  const mark = stopSent ? { stopSent: true as const } : {};
  if ("resolved" in outcome) return { at, exitCode: 0, cause: "exit", seen: "monitor", ...mark };
  const error = outcome.error;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const trailing = /:\s*(-?\d+)\s*$/u.exec(message);
  const exitCode =
    error instanceof Error && hasExitCode(error)
      ? error.exitCode
      : trailing
        ? Number(trailing[1])
        : null;
  const cause = message.includes("new version rollout")
    ? "rollout"
    : message.includes("runtime signalled the container to exit")
      ? "signal"
      : message.includes("no container instance") ||
          message.includes("maximum number of running container instances")
        ? "no_instance"
        : message.includes("exited with unexpected exit code") || exitCode !== null
          ? "exit"
          : "unknown";
  return {
    at,
    exitCode: cause === "no_instance" ? null : exitCode,
    cause,
    seen: "monitor",
    ...mark,
  };
}

/**
 * One durable record per runtime object of its container's current boot and how the boot before
 * it ended. The monitor is attached after every start and again by any instance that is
 * constructed while its container runs, which, after a version switch too, still receives the
 * exit. An instance that finds the container gone with no monitor outcome for the boot it
 * recorded writes `found_stopped`: the case of an object evicted while idle.
 */
export class ContainerEnds {
  private storage: Storage;
  private container: Container;
  private now: () => number;
  constructor(storage: Storage, container: Container, now: () => number = Date.now) {
    this.storage = storage;
    this.container = container;
    this.now = now;
  }
  private async read() {
    const value = await this.storage.get(key);
    return isEndRecord(value) ? value : undefined;
  }
  private foundStopped(boot: EndRecord["current"]): RuntimeEnd {
    return {
      at: this.now(),
      exitCode: null,
      cause: "unknown",
      seen: "found_stopped",
      ...(boot.stopSentAt !== undefined ? { stopSent: true as const } : {}),
    };
  }
  /** Right after `container.start()`: the boot before ends here at the latest. */
  async started() {
    const record = await this.read();
    const startedAt = this.now();
    const previous = record ? (record.current.end ?? this.foundStopped(record.current)) : undefined;
    await this.storage.put(key, { current: { startedAt }, ...(previous ? { previous } : {}) });
    this.watch(startedAt);
  }
  /** In an object's constructor: a container still running gets a monitor from this instance. */
  async constructed() {
    // Nothing to record without a monitor to hear the end.
    if (!this.container.running || typeof this.container.monitor !== "function") return;
    let record = await this.read();
    if (!record || record.current.end) {
      // Started by code from before this record: the boot it last recorded has ended.
      const previous = record?.current.end ?? record?.previous;
      record = { current: { startedAt: this.now() }, ...(previous ? { previous } : {}) };
      await this.storage.put(key, record);
    }
    this.watch(record.current.startedAt);
  }
  /** Before any stop of ours: its end then reads as a stop we sent, never a crash. */
  async stopSent() {
    const record = await this.read();
    if (!record || record.current.end) return;
    await this.storage.put(key, {
      ...record,
      current: { ...record.current, stopSentAt: this.now() },
    });
  }
  /** The record, with a boot found gone and no outcome from this instance's monitor ended. */
  async observe() {
    const record = await this.read();
    if (
      !record ||
      record.current.end ||
      this.container.running ||
      watching.get(this.container) === record.current.startedAt
    )
      return record;
    const ended = {
      ...record,
      current: { ...record.current, end: this.foundStopped(record.current) },
    };
    await this.storage.put(key, ended);
    return ended;
  }
  private watch(startedAt: number) {
    if (watching.get(this.container) === startedAt) return;
    let monitor: Promise<void>;
    try {
      monitor = this.container.monitor();
    } catch {
      return;
    }
    watching.set(this.container, startedAt);
    void monitor
      .then(
        () => this.settle(startedAt, { resolved: true }),
        (error: unknown) => this.settle(startedAt, { error }),
      )
      .catch(() => console.error("POOL_CONTAINER_END_UNRECORDED"));
  }
  private async settle(
    startedAt: number,
    outcome: { readonly resolved: true } | { readonly error: unknown },
  ) {
    if (watching.get(this.container) === startedAt) watching.delete(this.container);
    // A rejection with the container still up is a lost transport, not an end.
    if (this.container.running) return;
    const record = await this.read();
    if (!record || record.current.startedAt !== startedAt || record.current.end) return;
    const end = classifyEnd(outcome, this.now(), record.current.stopSentAt !== undefined);
    await this.storage.put(key, { ...record, current: { ...record.current, end } });
  }
}

/** Every runtime object's constructor: re-attach to a container that kept running through it. */
export function watchRunningContainer(ctx: {
  storage: Storage;
  container?: Container;
  waitUntil(work: Promise<unknown>): void;
}) {
  if (ctx.container)
    ctx.waitUntil(new ContainerEnds(ctx.storage, ctx.container).constructed().catch(() => {}));
}

/**
 * Before a stop of ours on this object's container, so its end never reads as a crash. The record
 * is a diagnostic: its failure never holds a stop.
 */
export async function markStopSent(ctx: { storage: Storage; container?: Container }) {
  if (!ctx.container) return;
  await new ContainerEnds(ctx.storage, ctx.container)
    .stopSent()
    .catch(() => console.error("POOL_CONTAINER_END_UNRECORDED"));
}

/** Right after `container.start()`; its failure never fails the start. */
export async function recordStart(ctx: { storage: Storage }, container: Container) {
  await new ContainerEnds(ctx.storage, container)
    .started()
    .catch(() => console.error("POOL_CONTAINER_END_UNRECORDED"));
}

/** How this object's container last ended, once it has; unreadable, nothing. */
export async function lastContainerEnd(ctx: { storage: Storage; container?: Container }) {
  if (!ctx.container) return undefined;
  return new ContainerEnds(ctx.storage, ctx.container)
    .observe()
    .then((record) => record?.current.end)
    .catch(() => undefined);
}
