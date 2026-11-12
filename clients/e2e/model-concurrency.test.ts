import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "./support.ts";
import { fixture } from "./native-client-fixture.ts";

test(
  "two hundred native model streams finish through separate tunnel sockets",
  { timeout: 30_000 },
  async () => {
    const connection = await fixture();
    try {
      await connection.login();
      await command(["agent", "add", "both", "models", "tools"], connection.home);
      const origin = await connection.start();
      const token = await connection.token();
      const responses = await Promise.all(
        Array.from({ length: 200 }, () =>
          fetch(`${origin}/v1/responses`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "synthetic", stream: true }),
          }),
        ),
      );
      assert.ok(responses.every((response) => response.status === 200));
      assert.equal(connection.remote.counts().modelSends, 200);
      connection.remote.complete();
      for (const body of await Promise.all(responses.map((response) => response.text()))) {
        assert.match(body, /data: first/);
        assert.match(body, /data: complete/);
      }
    } finally {
      await connection.close();
    }
  },
);
