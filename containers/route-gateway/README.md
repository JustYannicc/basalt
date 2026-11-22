# Route gateway

The route gateway is a container image that joins one person's tailnet as one device, and it's the only Signalbox device on that tailnet. Signalbox traffic that the person routes out through their tailnet leaves through it, via an exit node they picked. One gateway runs per connected route account, and its Durable Object is its only client. Both ports are reachable only through that object and never listen publicly.

| Port | What |
| --- | --- |
| 1080 | SOCKS5, no auth, `CONNECT` only. The forwarder checks the route before every connection, then hands the request to tailscaled's own SOCKS5 on loopback. |
| 8080 | Control, HTTP/1.1 JSON: `/start`, `/status`, `/login`, `/exits`, `/select`, `/logout`, `/state`. |

The wire contract is I1 in the #1380 slice-1 interfaces. The reason codes are part of that contract.

## Why the forwarder exists

tailscaled's SOCKS5 proxy fails open. Whenever no exit node is active, it dials the destination directly from the gateway's own address. That covers a logged-out node, an exit preference that's set but not applied, and an exit node that has left the netmap. tailscaled 1.104.7 also keeps reporting `ExitNodeStatus` as online after control deletes the exit node. So stop-when-down is enforced here, per connection, and never left to tailscaled:

1. The route is selected (`route_off` otherwise).
2. The node is started and signed in (`route_needs_login`), and its key hasn't expired (`route_key_expired`).
3. The prefs hold the selected exit (`route_not_selected`).
4. That exit is the active one and is in the netmap's peers (`route_exit_missing`).
5. Control reports it online (`route_exit_offline`).
6. It answered a disco ping in the last 6 s (`route_exit_unreachable`). A background loop pings every 2 s with a 2 s timeout.

If tailscaled's status call itself fails, the check stops at once with `route_status_unavailable`.

On a failure, `when_down=stop` replies `0x02` and dials nothing. `when_down=direct` dials from the gateway's own address, and `/status` then reports `direct_fallback`.

After tailscaled answers the CONNECT, and before the client sees that reply, steps 3–5 run again. The client can't send anything before the reply, so a netmap change that lands between the check and tailscaled's own dial can leak at most a bare TCP handshake from the gateway's address, never request bytes.

**Known gap:** that handshake isn't covered. Closing it needs packet filtering, which this unprivileged userspace gateway doesn't have.

DOMAIN targets are passed on unresolved, so with an exit node the name is resolved on the exit side.

## Privacy

- Logs are one JSON line per event and carry reason codes only: `route_refused`, `route_dial_failed`, `forwarder_busy`, `route_gateway_exit`.
- tailscaled's own output goes to `/dev/null`, because it prints login URLs and device names. Log upload to Tailscale is off.
- Device, exit and tailnet names, and the sign-in URL, appear only in control responses to the owning object.
- The node state lives in `/dev/shm` and leaves the container only through `GET /state`.

## Tests

- Unit tests: `python3 -m unittest discover -s containers/route-gateway -t containers/route-gateway` (Python 3.12, which CI runs).
- Local alone-proof: `python3 containers/route-gateway/e2e/rig_test.py run --evidence <file>`. It needs Docker, and runs these on internal Docker networks:
  - a scratch headscale v0.29.7 with TLS (tailscaled insists on 443);
  - one exit node;
  - a stand-in echo service on 203.0.113.0/24 and 198.51.100.0/24.

  It builds the image, runs the seven I1 checks plus a deletion under load (20 connection loops while the exit is deleted), and removes every container, network and image it created.

Lab notes for the rig:

- The exit node forwards only to its own LAN ranges once they're advertised and approved as subnet routes. The rig does that for both test ranges.
- headscale v0.27.1 never pushes a peer removal to other nodes, which is why the rig pins v0.29.7.
- The exit node resolves names through its DNS server, not `/etc/hosts`. So the DOMAIN check uses a Docker network alias that only the exit node can see.
