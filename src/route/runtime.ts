import { GatewayControl, RouteRefused, type GatewayContainer } from "./control.ts";
import type { ReasonCode, Selection } from "./reading.ts";

export type StartPurpose = "route" | "sign-in";
/** What a fresh node boots with, or why it must not boot. */
export type BootPlan =
  | { state: string | null; selection: Selection | undefined }
  | { refuse: ReasonCode };

export interface RuntimeHost {
  /** The state machine's current epoch; a start asked for in an older one starts nothing. */
  epoch(): number;
  plan(since: number, purpose: StartPurpose, identity: string | undefined): Promise<BootPlan>;
}

const startDeadlineMs = 30_000;

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
  get isStarting() {
    return this.starting !== undefined;
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
      if (purpose === "route" || this.starting.purpose === "sign-in") return this.starting.run;
      // A sign-in waits out a route start, which may refuse for want of an identity.
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
    // A cold start plans first, so a start that may not boot (no identity, or a seal no key opens)
    // refuses before launching a container to find that out.
    let planned: BootPlan | undefined;
    await this.stopping;
    if (!this.control.running) {
      planned = await this.host.plan(since, purpose, identity);
      this.live(launch);
      if ("refuse" in planned) throw new RouteRefused(planned.refuse);
    }
    for (;;) {
      this.live(launch);
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

  /** Every container start gets the identity and selection its plan names before anything else. */
  private async boot(
    launch: number,
    since: number,
    purpose: StartPurpose,
    identity: string | undefined,
    planned: BootPlan | undefined,
  ) {
    const plan = planned ?? (await this.host.plan(since, purpose, identity));
    this.live(launch);
    if ("refuse" in plan) {
      await this.control.destroy();
      throw new RouteRefused(plan.refuse);
    }
    await this.call(launch, () => this.control.start(plan.state));
    const { selection } = plan;
    if (selection) await this.call(launch, () => this.control.select(selection));
  }
}
