import type { RuntimeConfiguration } from "./configuration.ts";
import { readinessReadMs } from "./forced-restart-timing.ts";

type Port = (port: number) => {
  fetch(input: string, init?: RequestInit): Promise<Response>;
};

/** The supervisor's node-list audit gives up after this (`check_services` in pool_contract.py). */
export const auditDeadlineMs = 2_000;
/** The probe's own wait for the same listing, so a slow database that still works answers. */
export const auditListingReadMs = 10_000;
/** The supervisor's own wait for each database-free `/healthz`. */
const healthReadMs = 2_000;
/**
 * Home's `/healthz` touches no database, so even on a slow database it answers at once. A Home that
 * needs longer is itself slow, which a restart can cure, and is never evidence.
 */
export const homeHealthReadMs = 500;

/**
 * Tells a selected runtime whose readiness refuses only because the supervisor's database-backed
 * node-list audit missed its deadline from one that refuses for anything else. The pinned root's
 * `/ready` answers the same 503 for every cause, so the probe repeats the supervisor's own reads
 * with its own deadlines. It answers with evidence only when all of them hold: `/ready` refuses
 * this boot, the node's and Home's database-free `/healthz` answer, and Home's node listing answers
 * with a healthy node but slower than the audit's deadline. Anything else, including the probe's own
 * failure, is another cause and answers `undefined`. The supervisor's node id comes from its launch,
 * so the probe can't tell its own node from a fleet cell's in the cluster-wide listing.
 */
export class RuntimeAuditProbe {
  private port: Port;
  private now: () => number;
  // The listing is a query on a pool that is already full when this runs: never two at once.
  private listing = false;
  constructor(port: Port, now = () => performance.now()) {
    this.port = port;
    this.now = now;
  }
  async slowAudit(configuration: RuntimeConfiguration, bootId: string, signal: AbortSignal) {
    const key = configuration.managementKey;
    if (!key || this.listing) return undefined;
    const home = configuration.homePeerOrdinal === undefined ? 8327 : 8329;
    const managed = { "X-Management-Key": key };
    try {
      // Only this boot's own readiness refusal can be the audit's; nothing else is read otherwise.
      const ready = await this.read(
        8318,
        "/ready",
        { Authorization: `Bearer ${key}` },
        readinessReadMs,
        signal,
      );
      if (ready.status !== 503 || field(ready.body, "boot_id") !== bootId) return undefined;
      if (this.listing) return undefined;
      const listed = this.now();
      const listingDeadline = AbortSignal.any([signal, AbortSignal.timeout(auditListingReadMs)]);
      const request = this.request(home, "/v8/management/nodes", managed, listingDeadline);
      // In flight until the request itself settles, even when another read already failed or the
      // probe gave up waiting on it: never a second listing beside one that is still running.
      this.listing = true;
      const settled = () => {
        this.listing = false;
      };
      request.then(settled, settled);
      const listing = within(request, listingDeadline);
      const [node, homeHealth, nodes] = await Promise.all([
        this.read(8317, "/healthz", managed, healthReadMs, signal),
        this.read(home, "/healthz", managed, homeHealthReadMs, signal),
        listing.then((answer) => ({ ...answer, elapsedMs: this.now() - listed })),
      ]);
      const ok = (answer: { status: number; body: unknown }) =>
        answer.status === 200 && field(answer.body, "status") === "ok";
      if (!ok(node) || !ok(homeHealth)) return undefined;
      const entries = field(nodes.body, "nodes");
      // A listing with no healthy node fails the audit on its content, however fast it is.
      if (
        nodes.status !== 200 ||
        !Array.isArray(entries) ||
        !entries.some((entry: unknown) => field(entry, "healthy") === true)
      )
        return undefined;
      if (nodes.elapsedMs <= auditDeadlineMs) return undefined;
      return { listingMs: Math.round(nodes.elapsedMs) };
    } catch {
      return undefined;
    }
  }
  /** One read that answers within its deadline, even from a port that ignores the abort. */
  private read(
    port: number,
    path: string,
    headers: Record<string, string>,
    deadlineMs: number,
    signal: AbortSignal,
  ) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]);
    return within(this.request(port, path, headers, deadline), deadline);
  }
  private async request(
    port: number,
    path: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ) {
    const destination = this.port(port);
    const response = await destination.fetch(`http://pool${path}`, { headers, signal });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }
}

/** Settles when `work` does or when `signal` aborts, whichever is first. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function field(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? Reflect.get(body, name) : undefined;
}
