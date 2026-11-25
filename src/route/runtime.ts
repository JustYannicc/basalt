import { GatewayControl, RouteRefused, type GatewayContainer } from "./control.ts";
import type { ReasonCode, Selection } from "./reading.ts";

/**
 * What a start may boot: a poll only reads a node already up, a route start boots the stored
 * identity, and a sign-in may boot a node with none.
 */
export type StartPurpose = "poll" | "route" | "sign-in";
const reach: Record<StartPurpose, number> = { poll: 0, route: 1, "sign-in": 2 };
/** What a fresh node boots with, or why it must not boot. */
export type BootPlan = { state: string | null } | { refuse: ReasonCode };

export interface RuntimeHost {
  /** The state machine's current epoch; a start asked for in an older one starts nothing. */
  epoch(): number;
  plan(since: number, purpose: StartPurpose, identity: string | undefined): Promise<BootPlan>;
  /** The selection storage holds now. */
  selection(): Promise<Selection | undefined>;
}

const startDeadlineMs = 30_000;

/** A start its plan refused: nothing booted, and nothing was wrong with the gateway. */
export class Unbootable extends RouteRefused {}

/**
 * A fenced, serial handle on the route's one container. Every start and call belongs to a launch,
 * and `stop` ends the launch: a start in flight gives up, and a call queued before it never
 * reaches the next container. Control calls run one at a time, in the order they were asked for.
 */
export class GatewayRuntime {
  readonly control: GatewayControl;
  private host: RuntimeHost;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private current = 0;
  private starting: { purpose: StartPurpose; run: Promise<number> } | undefined;
  private channel: Promise<unknown> = Promise.resolve();
  /** The destroys asked for so far, one after another; a start waits for them before it launches. */
  private stopping: Promise<void> = Promise.resolve();

  constructor(
    container: GatewayContainer | undefined,
    host: RuntimeHost,
    clock: { now(): number; sleep(ms: number): Promise<void> },
  ) {
    this.control = new GatewayControl(container);
    this.host = host;
    this.now = clock.now;
    this.sleep = clock.sleep;
  }

  get running() {
    return this.control.running;
  }
  get launch() {
    return this.current;
  }

  /** Refuses the rest of a call whose launch a stop ended. */
  live(launch: number) {
    if (launch !== this.current) throw new RouteRefused("route_gateway_unavailable");
  }

  /** One control call at a time, and only to the container its launch started. */
  call<T>(launch: number, work: () => Promise<T>): Promise<T> {
    const run = this.channel.then(() => {
      this.live(launch);
      return work();
    });
    this.channel = run.catch(() => {});
    return run;
  }

  /**
   * Sends the gateway the selection that holds when the call runs. If that fails, the gateway may
   * still run a choice storage no longer holds, so it is stopped; its next start applies storage.
   */
  reconcile(launch: number, selection: () => Promise<Selection | undefined>) {
    this.call(launch, async () => {
      await this.control.select((await selection()) ?? { exitId: null, whenDown: "stop" });
    }).catch(async () => {
      if (launch === this.current) await this.stop();
    });
  }

  /**
   * Puts a running gateway back on storage once any start in flight is done, without starting one.
   * A node that is not up needs nothing: its boot applies storage.
   */
  align() {
    const started = this.starting?.run.catch(() => {}) ?? Promise.resolve();
    void started.then(() => {
      if (this.control.running) this.reconcile(this.current, () => this.host.selection());
    });
  }

  /**
   * Stops the gateway and abandons any start in flight, so the next caller starts afresh. The
   * destroy is ordered behind earlier ones, and no start launches until it is done, so a late
   * destroy can never take down a container started after it.
   */
  async stop() {
    this.current += 1;
    this.starting = undefined;
    const done = this.stopping.then(() => this.control.destroy());
    this.stopping = done.catch(() => {});
    await done;
  }

  /**
   * The launch a started gateway runs under. Callers share one start. A sign-in may boot a node with
   * no identity; any other start refuses to, because that node could only sit idle. A disconnect's
   * logout node boots the identity it is given and shares nothing.
   */
  async started(
    since: number,
    purpose: StartPurpose = "route",
    identity?: string,
  ): Promise<number> {
    // A start belongs to the epoch that asked for it; once an event moves on, it starts nothing.
    // A disconnect's logout node is fenced by the disconnect itself and always gets its start.
    if (identity === undefined && since !== this.host.epoch())
      throw new RouteRefused("route_gateway_unavailable");
    if (identity === undefined && this.starting) {
      if (reach[this.starting.purpose] >= reach[purpose]) return this.starting.run;
      // A start waits out one that may boot less than it needs, which may refuse.
      await this.starting.run.catch(() => {});
      return this.started(since, purpose);
    }
    const run = this.start(this.current, since, purpose, identity);
    if (identity === undefined) {
      const starting = { purpose, run };
      this.starting = starting;
      run
        .finally(() => {
          if (this.starting === starting) this.starting = undefined;
        })
        .catch(() => {});
    }
    return run;
  }

  private async start(
    launch: number,
    since: number,
    purpose: StartPurpose,
    identity: string | undefined,
  ): Promise<number> {
    const deadline = this.now() + startDeadlineMs;
    await this.stopping;
    for (;;) {
      this.live(launch);
      // Every launch is planned first, from what storage holds then, including a relaunch after a
      // crash mid-start, so a start that may not boot, or no longer has a reason to, refuses before
      // launching a container.
      let planned: BootPlan | undefined;
      if (!this.control.running) {
        planned = await this.host.plan(since, purpose, identity);
        this.live(launch);
        if ("refuse" in planned) throw new Unbootable(planned.refuse);
      }
      this.control.launch();
      const probe = await this.call(launch, () => this.control.probe());
      this.live(launch);
      if (probe === "started") return launch;
      if (probe === "unstarted") {
        await this.boot(launch, since, purpose, identity, planned);
        return launch;
      }
      if (this.now() >= deadline) throw new RouteRefused("route_gateway_unavailable");
      await this.sleep(250);
    }
  }

  /**
   * Every container start gets its plan's identity, then the selection storage holds when that call
   * runs, so a choice or a switch-off made while it booted is the one it applies. A disconnect's
   * logout node routes nothing.
   */
  private async boot(
    launch: number,
    since: number,
    purpose: StartPurpose,
    identity: string | undefined,
    planned: BootPlan | undefined,
  ) {
    const plan = planned ?? (await this.host.plan(since, purpose, identity));
    this.live(launch);
    // A container that must not boot is stopped in order behind earlier destroys, like any stop,
    // so its destroy can never land on a node started after it.
    if ("refuse" in plan) {
      await this.stop();
      throw new Unbootable(plan.refuse);
    }
    await this.call(launch, () => this.control.start(plan.state));
    if (identity !== undefined) return;
    await this.call(launch, async () => {
      const selection = await this.host.selection();
      if (selection) await this.control.select(selection);
    });
  }
}
