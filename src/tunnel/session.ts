import {
  decodeTunnelFrame,
  tunnelLimits,
  type TunnelServerFrame,
  type TunnelLimits,
} from "../../clients/contracts/tunnel.ts";
import type { TunnelAccess, TunnelEnvironment } from "./access.ts";
import { TunnelOperation } from "./operation.ts";
import type { TunnelSocket } from "./platform.ts";
import type { TunnelTiming } from "./timing.ts";

/**
 * How long a session may outlive its lease, from the loss: the session length the protocol tells
 * every client in READY. The grant's deadline still applies, whichever comes first. A call still
 * running then is cut, as a lease loss cut every call at once before.
 */
export const leaseLostLimitMs = tunnelLimits.sessionMilliseconds;
/** Close codes for an endpoint that went away rather than one that chose to end the session. */
const wentAway = new Set([1001, 1006]);
type Ended =
  | "operations"
  | "pool"
  | "bound"
  | "client"
  | "deadline"
  | "protocol"
  | "send"
  | "aborted";

export function serveTunnel(
  socket: TunnelSocket,
  /** The pool's session lease; a tools-only device has none. */
  lease: TunnelSocket | undefined,
  request: Request,
  env: TunnelEnvironment,
  access: TunnelAccess,
  keepAlive: (work: Promise<unknown>) => void,
  timing?: TunnelTiming,
  limits: TunnelLimits = tunnelLimits,
) {
  let stopped = false;
  let lastId = 0;
  const operations = new Map<number, TunnelOperation>();
  // The pool's instance holding the lease went away: in-flight calls finish, nothing new starts.
  let leaseLost:
    | { at: number; cause: "went_away" | "error"; code: number | null; operations: number }
    | undefined;
  let leaseLostTimer: ReturnType<typeof setTimeout> | undefined;
  // Model HTTP calls, which the pool governs on their own: each holds its own leases where it is
  // served, and each resume or replay of one passes the pool's admission.
  const governed = new Set<number>();
  // Installed clients compare READY limits exactly. The grant owns the actual session deadline.
  const expiresAt = access.expiresAt;
  const send = (frame: TunnelServerFrame) => {
    if (stopped) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      close(1011, "send");
    }
  };
  let finish!: () => void;
  keepAlive(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const close = (code: number, ended: Ended) => {
    if (stopped) return;
    stopped = true;
    timing?.mark("closed");
    clearTimeout(deadline);
    clearTimeout(leaseLostTimer);
    if (leaseLost)
      console.warn("NATIVE_TUNNEL_LEASE_LOST", {
        cause: leaseLost.cause,
        code: leaseLost.code,
        operations: leaseLost.operations,
        ended,
        heldMs: Date.now() - leaseLost.at,
      });
    // oxlint-disable-next-line unicorn/no-useless-spread -- Stop removes entries from the active map.
    for (const operation of [...operations.values()]) operation.stop();
    operations.clear();
    try {
      socket.close(code, "Session ended");
    } catch {}
    try {
      lease?.close(1000, "Session ended");
    } catch {}
    finish();
  };
  let deadline: ReturnType<typeof setTimeout>;
  const armDeadline = () => {
    deadline = setTimeout(
      () => {
        if (Date.now() >= expiresAt) close(1008, "deadline");
        else armDeadline();
      },
      Math.max(0, Math.min(2_147_483_647, expiresAt - Date.now())),
    );
  };
  armDeadline();
  request.signal.addEventListener("abort", () => close(1000, "aborted"), { once: true });
  socket.addEventListener("close", () => close(1000, "client"));
  socket.addEventListener("error", () => close(1011, "client"));
  const lost = (cause: "went_away" | "error", code: number | null) => {
    if (stopped) return;
    // An error comes first; the close that follows names the code.
    if (leaseLost) {
      leaseLost.code ??= code;
      return;
    }
    leaseLost = { at: Date.now(), cause, code, operations: operations.size };
    // Nothing at the pool reaches a tools call or a model socket once the lease is gone, so they
    // end here, as every call did before.
    // oxlint-disable-next-line unicorn/no-useless-spread -- Stop removes entries from the active map.
    for (const [id, operation] of [...operations])
      if (!governed.has(id)) {
        send({ v: 1, type: "error", id, code: "interrupted", outcome: "unknown" });
        operation.stop();
      }
    if (!operations.size) return close(1000, "operations");
    leaseLostTimer = setTimeout(() => close(1011, "bound"), leaseLostLimitMs);
  };
  // A close the pool sends is deliberate, a revocation among them, and ends the session at once.
  // A lease whose holder went away is lost: the model HTTP calls under way may be resumed or
  // replayed by the router, governed by the pool's admission; nothing new starts.
  lease?.addEventListener("close", (event) => {
    const { code, wasClean } = event as CloseEvent;
    if (wentAway.has(code)) return lost("went_away", code);
    // How often a deliberate close lands on calls under way, and with which code.
    if (operations.size && !stopped && !leaseLost)
      console.warn("NATIVE_TUNNEL_LEASE_CLOSED", {
        code: code ?? null,
        clean: wasClean ?? null,
        operations: operations.size,
      });
    close(1000, "pool");
  });
  lease?.addEventListener("error", () => lost("error", null));
  socket.addEventListener("message", (event) => {
    if (stopped) return;
    try {
      if (Date.now() >= expiresAt || typeof event.data !== "string")
        throw new Error("Session unavailable");
      const frame = decodeTunnelFrame(event.data, "client");
      if (frame.type === "open") {
        if (frame.id <= lastId || operations.size >= tunnelLimits.operations)
          throw new Error("Operation limit exceeded");
        lastId = frame.id;
        if (leaseLost) {
          send({ v: 1, type: "error", id: frame.id, code: "unavailable", outcome: "not-started" });
          return;
        }
        const allowed =
          frame.operation.service === "models"
            ? access.policy.models
            : access.policy.toolsOrganization !== undefined;
        if (!allowed) {
          send({ v: 1, type: "error", id: frame.id, code: "refused", outcome: "not-started" });
          return;
        }
        const operation = new TunnelOperation(
          frame,
          send,
          () => {
            operations.delete(frame.id);
            governed.delete(frame.id);
            if (leaseLost && !operations.size) close(1000, "operations");
          },
          timing?.operation(frame),
          limits,
        );
        operations.set(frame.id, operation);
        if (frame.operation.service === "models" && frame.operation.transport === "http")
          governed.add(frame.id);
        operation.begin();
        keepAlive(operation.run(request, env, access));
        return;
      }
      const operation = operations.get(frame.id);
      // A cancellation or in-flight acknowledgement may race the response's final frame.
      if (!operation) {
        // After a loss, what the device already sent for a call refused or stopped is dropped.
        if (leaseLost && frame.id <= lastId) return;
        if (frame.id <= lastId && (frame.type === "cancel" || frame.type === "credit")) return;
        throw new Error("Unknown operation");
      }
      if (frame.type === "data") operation.data(frame);
      else if (frame.type === "credit") operation.output.grant(frame.bytes);
      else if (frame.type === "end") operation.end();
      else operation.stop();
    } catch {
      close(1008, "protocol");
    }
  });
  lease?.accept();
  socket.accept();
  if (request.signal.aborted || Date.now() >= expiresAt) close(1008, "deadline");
  else {
    send({ v: 1, type: "ready", expiresAt, limits });
    if (!stopped) timing?.mark("ready");
  }
}
