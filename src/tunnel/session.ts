import {
  decodeTunnelFrame,
  tunnelLimits,
  type TunnelServerFrame,
} from "../../clients/contracts/tunnel.ts";
import type { TunnelAccess, TunnelEnvironment } from "./access.ts";
import { TunnelOperation } from "./operation.ts";
import type { TunnelSocket } from "./platform.ts";

export function serveTunnel(
  socket: TunnelSocket,
  lease: TunnelSocket,
  request: Request,
  env: TunnelEnvironment,
  access: TunnelAccess,
  keepAlive: (work: Promise<unknown>) => void,
) {
  let stopped = false;
  let lastId = 0;
  const operations = new Map<number, TunnelOperation>();
  const expiresAt = Math.min(access.expiresAt, Date.now() + tunnelLimits.sessionMilliseconds);
  const send = (frame: TunnelServerFrame) => {
    if (stopped) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      close(1011);
    }
  };
  let finish!: () => void;
  keepAlive(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const close = (code = 1000) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(deadline);
    for (const operation of [...operations.values()]) operation.stop();
    operations.clear();
    try {
      socket.close(code, "Session ended");
    } catch {}
    try {
      lease.close(1000, "Session ended");
    } catch {}
    finish();
  };
  const deadline = setTimeout(() => close(1008), Math.max(0, expiresAt - Date.now()));
  request.signal.addEventListener("abort", () => close(), { once: true });
  for (const remote of [socket, lease]) {
    remote.addEventListener("close", () => close());
    remote.addEventListener("error", () => close(1011));
  }
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
        const allowed =
          frame.operation.service === "models"
            ? access.policy.models
            : access.policy.toolsOrganization !== undefined;
        if (!allowed) {
          send({ v: 1, type: "error", id: frame.id, code: "refused", outcome: "not-started" });
          return;
        }
        const operation = new TunnelOperation(frame, send, () => operations.delete(frame.id));
        operations.set(frame.id, operation);
        operation.begin();
        keepAlive(operation.run(request, env));
        return;
      }
      const operation = operations.get(frame.id);
      // A cancellation or in-flight acknowledgement may race the response's final frame.
      if (!operation) {
        if (frame.id <= lastId && (frame.type === "cancel" || frame.type === "credit")) return;
        throw new Error("Unknown operation");
      }
      if (frame.type === "data") operation.data(frame);
      else if (frame.type === "credit") operation.output.grant(frame.bytes);
      else if (frame.type === "end") operation.end();
      else operation.stop();
    } catch {
      close(1008);
    }
  });
  lease.accept();
  socket.accept();
  if (request.signal.aborted || Date.now() >= expiresAt) close(1008);
  else send({ v: 1, type: "ready", expiresAt, limits: tunnelLimits });
}
