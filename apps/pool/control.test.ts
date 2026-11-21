import assert from "node:assert/strict";
import test from "node:test";
import { control } from "./control.ts";

const context = (fetch: typeof globalThis.fetch) =>
  ({
    app: {
      accounts: { pool: { headers: () => ({ authorization: "Bearer fixture-pool-account" }) } },
    },
    user: { id: "member" },
    signal: new AbortController().signal,
    fetch,
  }) as unknown as Parameters<typeof control>[0];

const unanswered = {
  ok: false,
  error: "backend_unavailable",
  message: "The pool didn't answer. Try again in a moment.",
};

test("an answer that names no error keeps the HTTP status it came with", async () => {
  // An empty 404 is what a layer in front of the pool Worker answers when the pool is not reached.
  assert.deepEqual(
    await control(
      context(async () => new Response(null, { status: 404 })),
      "/pool",
    ),
    { ...unanswered, status: 404 },
  );
  assert.deepEqual(
    await control(
      context(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
      "/pool",
    ),
    { ...unanswered, status: 502 },
  );
  // An error code alone is not the pool's own refusal: that carries a message too.
  assert.deepEqual(
    await control(
      context(async () => Response.json({ error: "not_found" }, { status: 404 })),
      "/pool",
    ),
    { ...unanswered, status: 404 },
  );
});

test("the pool's own refusal is returned as it was sent", async () => {
  const refusal = { error: "not_found", message: "That account isn't in this pool." };
  assert.deepEqual(
    await control(
      context(async () => Response.json(refusal, { status: 404 })),
      "/accounts/account-fixture/refresh",
      { method: "POST" },
    ),
    { ok: false, ...refusal },
  );
});
