import assert from "node:assert/strict";
import { test } from "node:test";
import { routeDownAnswer, routePeerAddress, routeSafeMessage } from "./route-refusal.ts";

// The node's own refusal text when route_peer.py answers 0x02 (pinned node, Docker integration).
const raw = JSON.stringify({
  error: {
    message: `Post "https://models.example.test/v1/chat/completions": socks connect tcp ${routePeerAddress}->models.example.test:443: unknown error connection not allowed by ruleset`,
    type: "server_error",
  },
});

test("a refused route reaches the caller as route_down, with no provider URL or proxy address", async () => {
  for (const [path, shape] of [
    ["/v1/chat/completions", "openai"],
    ["/v1/messages", "anthropic"],
  ] as const) {
    const request = new Request(`https://pool.example${path}`, { method: "POST" });
    const answer = await routeDownAnswer(request, new Response(raw, { status: 500 }));
    const text = await answer.text();
    assert.equal(answer.status, 503);
    assert.equal(answer.headers.get("X-Signalbox-Route-Refused"), "route_down");
    assert.ok(
      !text.includes(routePeerAddress) &&
        !text.includes("models.example.test") &&
        !text.includes("socks"),
    );
    const body = JSON.parse(text);
    if (shape === "anthropic") assert.equal(body.error.type, "api_error");
    else assert.equal(body.error.code, "route_down");
  }
});

test("other answers pass through byte for byte, including large and streamed errors", async () => {
  const request = new Request("https://pool.example/v1/chat/completions", { method: "POST" });
  const ok = new Response(`data: ${routePeerAddress}\n\n`, { status: 200 });
  assert.equal(await routeDownAnswer(request, ok), ok);
  const plain = await routeDownAnswer(
    request,
    new Response("quota", { status: 429, headers: { "Retry-After": "9" } }),
  );
  assert.equal(plain.status, 429);
  assert.equal(plain.headers.get("Retry-After"), "9");
  assert.equal(await plain.text(), "quota");
  const large = "x".repeat(200_000);
  const chunks = [large.slice(0, 70_000), large.slice(70_000)];
  const streamed = new ReadableStream({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
  });
  assert.equal(
    await (await routeDownAnswer(request, new Response(streamed, { status: 502 }))).text(),
    large,
  );
});

test("an account's status text never shows the route listener", () => {
  assert.equal(routeSafeMessage(`dial ${routePeerAddress}: refused`), "route_down");
  assert.equal(routeSafeMessage("quota exceeded"), "quota exceeded");
  assert.equal(routeSafeMessage(null), null);
});
