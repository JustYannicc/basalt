import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import type { ConnectionView } from "../contracts/connection.ts";

/** External protocol peer. It owns no client implementation or credential source. */
export async function nativeFixture() {
  let display: ConnectionView["display"];
  const sockets = new WebSocketServer({ noServer: true });
  const limits = {
    frameBytes: 32768,
    chunkBytes: 16384,
    windowBytes: 65536,
    requestBytes: 16777216,
    websocketRequestBytes: 1048576,
    operations: 16,
    sessionMilliseconds: 600000,
  };
  let origin = "",
    challenge = "",
    approved = false,
    access = "",
    refresh = "",
    generation = 0;
  let revoked = false,
    refreshes = 0,
    writes = 0,
    cancels = 0,
    polls = 0;
  let expiresIn = 3600,
    loseRefresh = false,
    dropTool = false;
  let denial = false,
    foreignApproval = false;
  let refuseRequest = false;
  let offline = false;
  let accessReads = 0;
  let healthReads = 0;
  let denyAccess = false;
  const holds = new Set<() => void>();
  let accessGate: ReturnType<typeof gate> | undefined;
  let refreshGate: ReturnType<typeof gate> | undefined;
  const server = createServer(async (request, response) => {
    if (offline) {
      request.socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const fields = new URLSearchParams(raw);
    const json = (status: number, body: unknown) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/" && request.method === "HEAD") {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers["x-api-key"], undefined);
      healthReads++;
      return json(404, {});
    }
    if (request.url === "/api/auth/oauth2/register") {
      const body = JSON.parse(raw);
      assert.equal(body.token_endpoint_auth_method, "none");
      assert.deepEqual(body.grant_types, [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ]);
      return json(201, { client_id: "fixture-client" });
    }
    if (request.url === "/api/auth/oauth2/device-authorization") {
      assert.equal(fields.get("resource"), `${origin}/native`);
      assert.equal(fields.get("code_challenge_method"), "S256");
      assert.equal(fields.get("scope"), "native offline_access");
      challenge = fields.get("code_challenge")!;
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/u);
      return json(200, {
        device_code: "synthetic-device-code",
        user_code: "BCDF-GHJK",
        verification_uri: `${origin}/native/device`,
        verification_uri_complete: `${foreignApproval ? "https://foreign.example.test" : origin}/native/device?user_code=BCDF-GHJK`,
        expires_in: 300,
        interval: 1,
      });
    }
    if (request.url === "/api/auth/oauth2/token") {
      if (fields.get("grant_type") === "refresh_token") {
        refreshes++;
        if (revoked || fields.get("refresh_token") !== refresh)
          return json(400, { error: "invalid_grant" });
        const held = refreshGate;
        refreshGate = undefined;
        if (held) {
          response.once("close", held.cancel);
          held.arrive();
          await held.released;
          if (response.destroyed) return;
        }
        if (loseRefresh) {
          request.socket.destroy();
          return;
        }
        assert.equal(fields.get("resource"), `${origin}/native`);
      } else {
        polls++;
        if (denial) return json(400, { error: "access_denied" });
        assert.equal(
          createHash("sha256").update(fields.get("code_verifier")!).digest("base64url"),
          challenge,
        );
        assert.equal(fields.get("device_code"), "synthetic-device-code");
        if (!approved) return json(400, { error: "authorization_pending" });
      }
      access = `synthetic-access-${++generation}`;
      refresh = `synthetic-refresh-${generation}`;
      return json(200, {
        access_token: access,
        refresh_token: refresh,
        expires_in: expiresIn,
        token_type: "Bearer",
        scope: "native offline_access",
      });
    }
    if (request.url === "/api/auth/native/access") {
      accessReads++;
      if (denyAccess) return json(401, {});
      const held = accessGate;
      accessGate = undefined;
      if (held) {
        response.once("close", held.cancel);
        held.arrive();
        await held.released;
        if (response.destroyed) return;
      }
      if (revoked || request.headers.authorization !== `Bearer ${access}`) return json(401, {});
      return json(200, {
        id: "native:fixture",
        userId: "synthetic-person",
        clientId: "fixture-client",
        policy: {
          kind: "native",
          computer: "fixture-computer",
          pool: "fixture-pool",
          models: true,
          toolsOrganization: "personal-tools",
        },
        expiresAt: Date.now() + 3600000,
        ...(display ? { display } : {}),
      });
    }
    if (request.url === "/api/auth/native/revoke") {
      assert.equal(request.headers.authorization, `Bearer ${access}`);
      revoked = true;
      for (const socket of sockets.clients) socket.close(1008);
      return json(200, { revoked: true });
    }
    return json(404, {});
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      revoked ||
      request.url !== "/native/v1/tunnel" ||
      request.headers.authorization !== `Bearer ${access}`
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    assert.equal(request.headers["sec-websocket-protocol"], "basalt.tunnel.v1");
    sockets.handleUpgrade(request, socket, head, (peer) => {
      const send = (frame: object) =>
        peer.readyState === peer.OPEN && peer.send(JSON.stringify({ v: 1, ...frame }));
      let operation:
        | { service: string; method: string; path: string; transport: string }
        | undefined;
      let body: Buffer[] = [],
        message: Buffer[] = [],
        outputCredit = 0,
        running = false;
      const output: {
        bytes: Buffer;
        text: boolean;
        message: boolean;
        end: boolean;
        offset: number;
      }[] = [];
      const flush = () => {
        if (running) return;
        running = true;
        try {
          while (output.length) {
            const item = output[0]!;
            if (!item.bytes.length)
              send({ type: "data", id: 1, bytes: "", text: item.text, more: false });
            while (item.offset < item.bytes.length) {
              if (!outputCredit) return;
              const size = Math.min(outputCredit, 16384, item.bytes.length - item.offset);
              outputCredit -= size;
              const bytes = item.bytes.subarray(item.offset, item.offset + size);
              item.offset += size;
              send({
                type: "data",
                id: 1,
                bytes: bytes.toString("base64"),
                text: item.text,
                ...(item.message ? { more: item.offset < item.bytes.length } : {}),
              });
            }
            output.shift();
            if (item.end) send({ type: "end", id: 1 });
          }
        } finally {
          running = false;
        }
      };
      const data = (bytes: Buffer, text = false, message = false, end = false) => {
        output.push({ bytes, text, message, end, offset: 0 });
        flush();
      };
      const response = (status: number, headers: Record<string, string> = {}) =>
        send({ type: "response", id: 1, status, headers });
      const finish = () => {
        assert.ok(operation);
        if (operation.service === "tools") {
          const rpc = JSON.parse(Buffer.concat(body).toString());
          if (rpc.method === "tools/call") {
            writes++;
            if (dropTool) {
              peer.terminate();
              return;
            }
          }
          response(200, {
            "content-type": "application/json",
            "mcp-session-id": "fixture-session",
          });
          data(
            Buffer.from(
              JSON.stringify({
                jsonrpc: "2.0",
                id: rpc.id,
                result: { receipt: "synthetic-tool-receipt" },
              }),
            ),
            false,
            false,
            true,
          );
        } else {
          response(200, { "content-type": "text/event-stream" });
          data(Buffer.from("data: first\n\n"));
          const complete = () => {
            holds.delete(complete);
            data(Buffer.from("data: complete\n\n"), false, false, true);
          };
          holds.add(complete);
        }
      };
      peer.on("message", (raw) => {
        const frame = JSON.parse(raw.toString());
        assert.equal(frame.id, 1);
        if (frame.type === "open") {
          operation = frame.operation;
          assert.equal(frame.headers.authorization, undefined);
          assert.equal(frame.headers.cookie, undefined);
          if (refuseRequest) {
            send({ type: "credit", id: 1, bytes: 65536 });
            response(429, { "content-type": "application/json", "retry-after": "7" });
            data(Buffer.from('{"error":"synthetic-limit"}'), false, false, true);
            return;
          }
          if (operation!.transport === "websocket") {
            response(101);
            send({ type: "credit", id: 1, bytes: 65536 });
          } else if (operation!.method === "POST") send({ type: "credit", id: 1, bytes: 65536 });
        } else if (frame.type === "credit") {
          outputCredit += frame.bytes;
          flush();
        } else if (frame.type === "data") {
          if (refuseRequest) return;
          const bytes = Buffer.from(frame.bytes, "base64");
          assert.ok(bytes.length <= 16384);
          if (operation!.transport === "websocket") {
            message.push(bytes);
            if (!frame.more) {
              const value = Buffer.concat(message);
              message = [];
              data(value, frame.text, true);
              if (value.length) send({ type: "credit", id: 1, bytes: value.length });
            }
          } else {
            body.push(bytes);
            if (bytes.length) send({ type: "credit", id: 1, bytes: bytes.length });
          }
        } else if (frame.type === "end" && !refuseRequest) finish();
        else if (frame.type === "cancel") {
          cancels++;
          peer.close();
        }
      });
      peer.on("error", () => undefined);
      send({ type: "ready", expiresAt: Date.now() + 600000, limits });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    offline: (value: boolean) => {
      offline = value;
    },
    denyAccess: (value: boolean) => {
      denyAccess = value;
    },
    holdAccess: () => {
      accessGate = gate();
      return accessGate;
    },
    holdRefresh: () => {
      refreshGate = gate();
      return refreshGate;
    },
    approve: () => {
      approved = true;
    },
    beginApproval: () => {
      approved = false;
      denial = false;
    },
    display: (value: ConnectionView["display"]) => {
      display = value;
    },
    deny: () => {
      denial = true;
    },
    foreignApproval: () => {
      foreignApproval = true;
    },
    refuseRequest: () => {
      refuseRequest = true;
    },
    expireNext: (seconds: number) => {
      expiresIn = seconds;
    },
    loseRefresh: () => {
      loseRefresh = true;
    },
    dropTool: (value: boolean) => {
      dropTool = value;
    },
    complete: () => {
      for (const finish of holds) finish();
    },
    interrupt: () => {
      for (const socket of sockets.clients) socket.terminate();
    },
    counts: () => ({ refreshes, writes, cancels, polls, accessReads, healthReads }),
    close: async () => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function gate() {
  let arrive!: () => void, cancel!: () => void, release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrive, cancel, release, arrived, cancelled, released };
}
