import { decodeTunnelFrame, tunnelProtocol, tunnelMessageProtocol } from "../contracts/tunnel.ts";
import type { WireSocket } from "../contracts/transport.ts";

/** Only an unaccepted v2 handshake can fall back. No operation has been sent at that point. */
export function negotiatedTunnelSocket(
  connect: (protocol: string) => WireSocket,
  statuslessErrors = false,
): WireSocket {
  let active: { peer: WireSocket; unlisten?: () => void } | undefined;
  let stopped = false;
  let observed = false;
  let generation = 0;
  return {
    send: (value) => {
      if (!active || stopped) throw new Error("Tunnel is closed.");
      active.peer.send(value);
    },
    close: () => {
      stopped = true;
      generation++;
      active?.unlisten?.();
      active?.peer.close();
    },
    listen: (receive) => {
      const start = (protocol: string) => {
        const current = ++generation;
        const peer = connect(protocol);
        const connection: { peer: WireSocket; unlisten?: () => void } = { peer };
        active = connection;
        const unlisten = peer.listen((event) => {
          if (stopped || current !== generation) return;
          const refused =
            event.type === "error" &&
            (event.status === 400 ||
              event.status === 426 ||
              (statuslessErrors && event.status === undefined));
          if (!observed && protocol === tunnelMessageProtocol && refused) {
            generation++;
            connection.unlisten?.();
            peer.close();
            start(tunnelProtocol);
            return;
          }
          // Any server frame seals the selected session, including a malformed READY.
          if (event.type === "message" && !observed) {
            observed = true;
            try {
              if (typeof event.data !== "string") throw new Error("Invalid READY.");
              const frame = decodeTunnelFrame(event.data, "server");
              if (
                frame.type !== "ready" ||
                (frame.limits.websocketMessageBytes !== undefined) !==
                  (protocol === tunnelMessageProtocol)
              )
                throw new Error("Incompatible message envelope.");
            } catch {
              receive({ type: "error" });
              return;
            }
          }
          receive(event);
        });
        if (active !== connection || stopped) unlisten();
        else connection.unlisten = unlisten;
      };
      if (!stopped) start(tunnelMessageProtocol);
      return () => {
        stopped = true;
        generation++;
        active?.unlisten?.();
      };
    },
  };
}
