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
2. The node is started and signed in: `route_key_expired` when it is signed out with a past key expiry, otherwise `route_needs_login`.
3. The prefs hold the selected exit (`route_not_selected`).
4. That exit is the active one, is in the netmap's peers and still offers an exit route (`route_exit_missing`).
5. Control reports it online (`route_exit_offline`).
6. It answered a disco ping in the last 6 s (`route_exit_unreachable`). A background loop pings every 2 s with a 2 s timeout.

If tailscaled's status call itself fails, the check stops at once with `route_status_unavailable`.

On a failure, `when_down=stop` replies `0x02` and dials nothing. `when_down=direct` dials from the gateway's own address, and `/status` then reports `direct_fallback`.

After tailscaled answers the CONNECT, and before the client sees that reply, steps 3–5 run again. A client can't send anything before the reply, so a re-check that fails closes the connection with no request sent.

**Known gap:** if the exit node is deleted or loses its exit route in the microseconds between the check and tailscaled's own dial, a bare TCP handshake (SYN, then the connection setup) can leave from the gateway's own address to the destination. No request, no account and no content can follow, because the re-check refuses before the client may send. The gateway can't stop the handshake itself: that would need packet filtering, which requires privileges an unprivileged userspace container doesn't have. The rig's deletion and route-revocation runs under load recorded 0 requests and 0 handshakes from the gateway's address.

`state_revision` goes up whenever tailscaled rewrites its state file. That happens on login, key rotation and logout, and also on a preference change such as `/select`. A logout also discards the state file and starts tailscaled again from nothing, so the next `/state` carries no identity of the old device.

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
