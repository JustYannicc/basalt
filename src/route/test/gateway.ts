import type { GatewayContainer } from "../control.ts";
import type { GatewayDependencies, GatewayStorage } from "../gateway.ts";
import type { RouteReadingChanged } from "../reading.ts";

/** An in-memory I1 gateway: the stand-in the interface describes, with knobs for failure. */
export class FakeGateway implements GatewayContainer {
  running = false;
  starts: Array<string | null> = [];
  selects: Array<{ exit_id: string | null; when_down: string }> = [];
  logouts = 0;
  destroyed = 0;
  reachable = true;
  inactivity: number[] = [];
  private bootCount = 0;
  private boot:
    | {
        id: string;
        state: string | null;
        revision: number;
        selection?: { exit_id: string | null; when_down: string };
        /** The node key expired: the identity is still on disk, but it is signed out. */
        expired?: boolean;
      }
    | undefined;
  /** What a login turns into; the "state file" the gateway would hand back. */
  loginState = "node-state-after-login";
  pendingLogin = false;
  /** The next /select fails, as a timeout or a refused socket would. */
  failSelects = 0;
  /** The real gateway checks routing off before sign-in; the default fake checks sign-in first. */
  offFirst = false;
  /** The next start ignores the identity it is given, as an expired or revoked node key would. */
  forgetState = false;
  /** Identities whose node key expired; the tailnet keeps them expired across restarts. */
  private expiredStates = new Set<string>();
  /** The next /state read fails once. */
  failStates = 0;
  /** The next reply to this path is not the I1 shape. */
  garbleNext: string | undefined;
  /** Whether the chosen exit answers; when it does not, the gateway reports the route down. */
  exitOnline = true;
  /**
   * Manual mode: every control request waits in `waiting` until a scheduler releases it, either
   * answered ("ok") or failed like a reset connection ("fail").
   */
  manual = false;
  /**
   * "fail" is a request that never reached the gateway; "lost" one the gateway processed whose
   * reply never came back (a timeout). A destroy and a warm-up wait here too, as container I/O.
   */
  waiting: Array<{
    path: string;
    body: unknown;
    release(outcome: "ok" | "fail" | "lost"): void;
  }> = [];
  /** Called on every container launch, before the node in it has been started. */
  onLaunch: (() => void) | undefined;
  /** Which container instance is up; a request in flight when it goes down dies with it. */
  private instance = 0;
  /** Every control request's path, in arrival order. */
  requests: string[] = [];
  /** Called with the identity each node is started from. */
  onStart: ((state: string | null) => void) | undefined;
  /** Whether a node runs signed in, i.e. a device the tailnet knows is up. */
  get signedIn() {
    return this.running && !!this.boot?.state;
  }
  /** The exit the running node routes through, or null while it routes nothing. */
  get appliedExit() {
    return this.running && this.boot?.state && !this.boot.expired
      ? (this.boot.selection?.exit_id ?? null)
      : null;
  }
  private gates = new Map<
    string,
    { opened: Promise<void>; arrived: () => void; reply: "before" | "after" }
  >();

  /**
   * Holds the next request to `path` until released, so a test can run another call while it is
   * in flight. "before" holds it unprocessed: released after the container stopped, it fails like
   * a reset connection. "after" processes it and holds only its reply on the way back.
   */
  hold(path: string, reply: "before" | "after" = "before") {
    let open!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => (arrived = resolve));
    this.gates.set(path, {
      opened: new Promise<void>((resolve) => (open = resolve)),
      arrived,
      reply,
    });
    return { reached, release: open };
  }

  start(options: { enableInternet: boolean }) {
    if (!options.enableInternet) throw new Error("The gateway needs the internet");
    if (!this.running) {
      this.instance += 1;
      this.onLaunch?.();
    }
    this.running = true;
    this.boot = undefined;
    this.pendingLogin = false;
  }
  async destroy() {
    this.destroyed += 1;
    if (this.manual) await this.io("destroy");
    this.instance += 1;
    this.bury();
    this.running = false;
    this.boot = undefined;
    this.pendingLogin = false;
  }
  async setInactivityTimeout(ms: number) {
    if (this.manual) await this.io("warm");
    this.inactivity.push(ms);
  }
  /** Closes every tunnel of a container that went away. */
  private dying = new Set<() => void>();
  private bury() {
    for (const close of this.dying) close();
    this.dying.clear();
  }
  /** Container I/O the scheduler releases; it may let other events in, but never fails here. */
  private async io(path: string) {
    await new Promise<"ok" | "fail" | "lost">((resolve) =>
      this.waiting.push({ path, body: undefined, release: resolve }),
    );
  }
  /** The container restarted underneath the DO (a deploy, a crash). */
  crash() {
    this.instance += 1;
    this.bury();
    this.running = false;
    this.boot = undefined;
    this.pendingLogin = false;
  }
  /** The person approved the login link. */
  approve() {
    if (!this.boot || !this.pendingLogin) throw new Error("No login to approve");
    this.pendingLogin = false;
    this.boot.state = this.loginState;
    this.boot.expired = false;
    this.expiredStates.delete(this.loginState);
    this.boot.revision += 1;
  }
  /** The running node's key expires; a new sign-in issues a link on the same identity. */
  expireKey() {
    if (!this.boot?.state) return;
    this.boot.expired = true;
    this.expiredStates.add(this.boot.state);
  }
  /** Whether the running node is signed out because its key expired. */
  get keyExpired() {
    return this.running && !!this.boot?.expired;
  }
  /** Tunnels open now: each dies with the container it was opened on. */
  openTunnels = 0;

  private status() {
    const boot = this.boot!;
    const loggedIn = boot.state !== null && !boot.expired;
    const selection = boot.selection;
    const off = !selection || selection.exit_id === null;
    const down =
      this.offFirst && off
        ? "route_off"
        : !loggedIn
          ? boot.expired
            ? "route_key_expired"
            : "route_needs_login"
          : off
            ? "route_off"
            : !this.exitOnline
              ? "route_exit_offline"
              : null;
    return {
      boot_id: boot.id,
      state: !loggedIn ? "needs_login" : down ? "down" : "ready",
      reason: down,
      when_down: selection?.when_down ?? "stop",
      exit:
        selection?.exit_id && loggedIn
          ? {
              id: selection.exit_id,
              name: "home-exit",
              online: this.exitOnline,
              path: "relay",
              relay_region: "fra",
            }
          : null,
      node: {
        logged_in: loggedIn,
        key_expiry: loggedIn ? "2027-05-21T00:00:00Z" : null,
        tailnet: loggedIn ? "example-tailnet" : null,
        name: loggedIn ? "signalbox-route" : null,
        id: loggedIn ? "node-1" : null,
      },
      state_revision: boot.revision,
    };
  }

  private async handle(method: string, path: string, body: unknown): Promise<Response> {
    this.requests.push(path);
    const instance = this.instance;
    let outcome: "ok" | "fail" | "lost" = "ok";
    if (this.manual) {
      outcome = await new Promise<"ok" | "fail" | "lost">((resolve) =>
        this.waiting.push({ path, body, release: resolve }),
      );
      if (outcome === "fail") throw new TypeError("connection reset");
    }
    const gate = this.gates.get(path);
    if (gate) this.gates.delete(path);
    if (gate?.reply === "before") {
      gate.arrived();
      await gate.opened;
    }
    // A connection to a container that has since stopped is gone, whatever starts after it.
    if (instance !== this.instance) throw new TypeError("connection reset");
    if (this.garbleNext === path) {
      this.garbleNext = undefined;
      return Response.json({ exits: "https://login.example.invalid/a/leak" });
    }
    const response = await this.answer(method, path, body);
    if (outcome === "lost") throw new TypeError("reply lost");
    if (gate?.reply === "after") {
      gate.arrived();
      await gate.opened;
    }
    return response;
  }

  private async answer(method: string, path: string, body: unknown): Promise<Response> {
    if (!this.running || !this.reachable) throw new TypeError("connection refused");
    if (path === "/start" && method === "POST") {
      if (this.boot) return Response.json({ error: "route_gateway_unavailable" }, { status: 409 });
      const state = this.forgetState ? null : (body as { state: string | null }).state;
      this.starts.push(state);
      this.onStart?.(state);
      this.bootCount += 1;
      this.boot = {
        id: `boot-${this.bootCount}`,
        state,
        revision: 0,
        expired: state !== null && this.expiredStates.has(state),
      };
      return Response.json({ boot_id: this.boot.id });
    }
    if (!this.boot) return Response.json({ error: "route_gateway_unavailable" }, { status: 409 });
    if (path === "/status" && method === "GET") return Response.json(this.status());
    if (path === "/login" && method === "POST") {
      if (this.boot.state !== null && !this.boot.expired) return Response.json({ state: "ready" });
      this.pendingLogin = true;
      return Response.json({ url: "https://login.example.invalid/a/test" });
    }
    if (path === "/exits" && method === "GET")
      return Response.json({
        exits: [
          { id: "n1", name: "home-exit", online: true, last_seen: null },
          { id: "n2", name: "away-exit", online: false, last_seen: "2026-11-20T08:00:00Z" },
        ],
      });
    if (path === "/select" && method === "POST") {
      if (this.failSelects > 0) {
        this.failSelects -= 1;
        throw new TypeError("connection reset");
      }
      const selection = body as { exit_id: string | null; when_down: string };
      this.selects.push(selection);
      this.boot.selection = selection;
      // The gateway rewrites its prefs, and with them the state file (I1).
      this.boot.revision += 1;
      return Response.json(this.status());
    }
    if (path === "/logout" && method === "POST") {
      this.logouts += 1;
      this.boot.state = null;
      this.boot.revision += 1;
      return Response.json({});
    }
    if (path === "/state" && method === "GET" && this.failStates > 0) {
      this.failStates -= 1;
      return Response.json({ error: "route_status_unavailable" }, { status: 503 });
    }
    if (path === "/state" && method === "GET")
      return Response.json({ state: this.boot.state ?? "", state_revision: this.boot.revision });
    return Response.json({ error: "bad_request" }, { status: 400 });
  }

  getTcpPort(port: number) {
    return {
      fetch: async (input: string, init?: RequestInit) => {
        if (port !== 8080) throw new Error(`Control is on 8080, not ${port}`);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return this.handle(init?.method ?? "GET", new URL(input).pathname, body);
      },
      connect: () => {
        if (port !== 1080) throw new Error(`SOCKS is on 1080, not ${port}`);
        if (!this.running || !this.reachable || !this.boot) {
          const refused = Promise.reject(new TypeError("connection refused"));
          refused.catch(() => {});
          const pipe = new TransformStream<Uint8Array, Uint8Array>();
          return {
            opened: refused,
            readable: pipe.readable,
            writable: pipe.writable,
            close: async () => {},
          };
        }
        const echo = new TransformStream<Uint8Array, Uint8Array>();
        const instance = this.instance;
        let open = false;
        const close = async () => {
          if (open) this.openTunnels -= 1;
          open = false;
        };
        // In manual mode the socket opens only when the scheduler says, like real TCP.
        const opened = (this.manual ? this.io("connect") : Promise.resolve()).then(() => {
          if (instance !== this.instance || !this.running) throw new TypeError("connection reset");
          open = true;
          this.openTunnels += 1;
          const tunnelInstance = this.instance;
          this.dying.add(() => {
            if (open && tunnelInstance !== this.instance) void close();
          });
        });
        opened.catch(() => {});
        return { opened, readable: echo.readable, writable: echo.writable, close };
      },
    };
  }
}

export class MemoryStorage implements GatewayStorage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) {
    const value = this.values.get(key);
    return value === undefined ? undefined : (structuredClone(value) as T);
  }
  async put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
  }
  async delete(keys: string[]) {
    let removed = 0;
    for (const key of keys) if (this.values.delete(key)) removed += 1;
    return removed;
  }
  async setAlarm(at: number) {
    this.alarm = at;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
}

export function gatewayDependencies(overrides: Partial<GatewayDependencies> = {}) {
  let now = 1_000_000;
  const events: RouteReadingChanged[] = [];
  const logs: string[] = [];
  const storage = new MemoryStorage();
  const container = new FakeGateway();
  const deps: GatewayDependencies = {
    storage,
    container,
    name: undefined,
    secret: "a".repeat(64),
    previousSecret: undefined,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    emit: (event) => events.push(event),
    log: (line) => logs.push(line),
    ...overrides,
  };
  return { deps, storage, container, events, logs, advance: (ms: number) => (now += ms) };
}
