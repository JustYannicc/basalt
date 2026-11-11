import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startGateway } from "../cli/gateway.ts";
import { tokenHash } from "../cli/local-access.ts";
import { ModelRequestNotSent } from "../contracts/model-error.ts";
import type { CredentialSource } from "../contracts/connection.ts";

for (const temporary of [false, true])
  test(`a ${temporary ? "temporary access outage is retryable" : "malformed raw path is a permanent local refusal"}`, async () => {
    const home = await mkdtemp(join(tmpdir(), "native-local-refusal-"));
    const token = "synthetic_local_token_01234567890123456789";
    let opens = 0;
    const source: CredentialSource = {
      view: () => ({ mode: "device", state: "connected", capabilities: ["models"] }),
      origins: () => [],
      transport: async () => {
        if (temporary) throw new ModelRequestNotSent("Synthetic authorization network outage.");
        return {
          mode: "device",
          capabilities: ["models"],
          open: () => {
            opens++;
            throw new Error("Invalid input must never open a tunnel.");
          },
        };
      },
      disconnect: async () => {},
      reconnect: async () => {},
      signOut: async () => {},
      revoke: async () => {},
    };
    const gateway = await startGateway({
      source,
      port: 0,
      operatorHash: tokenHash(token),
      ipcPath: join(home, "gateway.sock"),
      profile: async () => ({
        version: 1,
        storage: "os",
        port: 0,
        agents: [
          {
            id: "synthetic",
            name: "Synthetic",
            tokenHash: tokenHash(token),
            capabilities: ["models"],
          },
        ],
      }),
    });
    try {
      const response = await new Promise<{
        status: number;
        headers: import("node:http").IncomingHttpHeaders;
        body: string;
      }>((resolve, reject) => {
        const local = request(
          gateway.origin,
          {
            path: temporary ? "/v1/models" : "/v1/../v1/models",
            headers: { authorization: `Bearer ${token}` },
          },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8").on("data", (chunk) => {
              body += chunk;
            });
            incoming
              .on("error", reject)
              .on("end", () =>
                resolve({ status: incoming.statusCode!, headers: incoming.headers, body }),
              );
          },
        );
        local.on("error", reject).end();
      });
      assert.equal(response.status, temporary ? 503 : 502);
      assert.equal(response.headers["retry-after"], temporary ? "1" : undefined);
      assert.equal(response.headers["x-should-retry"], temporary ? undefined : "false");
      assert.equal(opens, 0);
      assert.doesNotMatch(response.body, /outcome.*unknown/iu);
    } finally {
      await gateway.close();
      await rm(home, { recursive: true, force: true });
    }
  });
