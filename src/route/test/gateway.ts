import type { GatewayContainer, GatewayDependencies, GatewayStorage } from "../gateway.ts";
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
      }
    | undefined;
  /** What a login turns into; the "state file" the gateway would hand back. */
  loginState = "node-state-after-login";
  pendingLogin = false;

  start(options: { enableInternet: boolean }) {
    if (!options.enableInternet) throw new Error("The gateway needs the internet");
    this.running = true;
    this.boot = undefined;
  }
  async destroy() {
    this.destroyed += 1;
    this.running = false;
    this.boot = undefined;
  }
  async setInactivityTimeout(ms: number) {
    this.inactivity.push(ms);
  }
  /** The container restarted underneath the DO (a deploy, a crash). */
  crash() {
    this.running = false;
    this.boot = undefined;
  }
  /** The person approved the login link. */
  approve() {
    if (!this.boot || !this.pendingLogin) throw new Error("No login to approve");
    this.pendingLogin = false;
    this.boot.state = this.loginState;
    this.boot.revision += 1;
  }

  private status() {
    const boot = this.boot!;
    const loggedIn = boot.state !== null;
    const selection = boot.selection;
    const down = !loggedIn
      ? "route_needs_login"
      : !selection || selection.exit_id === null
        ? "route_off"
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
              online: true,
              path: "relay",
              relay_region: "fra",
            }
          : null,
      node: { logged_in: loggedIn, key_expiry: null, tailnet: loggedIn ? "example-tailnet" : null },
      state_revision: boot.revision,
    };
  }

  private async handle(method: string, path: string, body: unknown): Promise<Response> {
    if (!this.running || !this.reachable) throw new TypeError("connection refused");
    if (path === "/start" && method === "POST") {
      if (this.boot) return Response.json({ error: "route_gateway_unavailable" }, { status: 409 });
      const state = (body as { state: string | null }).state;
      this.starts.push(state);
      this.bootCount += 1;
      this.boot = { id: `boot-${this.bootCount}`, state, revision: 0 };
      return Response.json({ boot_id: this.boot.id });
    }
    if (!this.boot) return Response.json({ error: "route_gateway_unavailable" }, { status: 409 });
    if (path === "/status" && method === "GET") return Response.json(this.status());
    if (path === "/login" && method === "POST") {
      if (this.boot.state !== null) return Response.json({ state: "ready" });
      this.pendingLogin = true;
      return Response.json({ url: "https://login.example.invalid/a/test" });
    }
    if (path === "/exits" && method === "GET")
      return Response.json({ exits: [{ id: "n1", name: "home-exit", online: true }] });
    if (path === "/select" && method === "POST") {
      const selection = body as { exit_id: string | null; when_down: string };
      this.selects.push(selection);
      this.boot.selection = selection;
      return Response.json(this.status());
    }
    if (path === "/logout" && method === "POST") {
      this.logouts += 1;
      this.boot.state = null;
      this.boot.revision += 1;
      return Response.json({});
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
        return {
          opened: Promise.resolve(),
          readable: echo.readable,
          writable: echo.writable,
          close: async () => {},
        };
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
    ...overrides,
  };
  return { deps, storage, container, events, advance: (ms: number) => (now += ms) };
}
