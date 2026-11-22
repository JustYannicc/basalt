import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fetchController, type ControllerHop } from "./controller-reset.ts";
import { containerAnswer, reachedNoContainer } from "./controller-unsent.ts";
import { rememberRuntimeFailure } from "./runtime-route-diagnostic.ts";

const mark = "X-Signalbox-Controller-Unsent";
const body = JSON.stringify({
  model: "claude-opus-5-5",
  messages: [{ role: "user", content: "hi" }],
});
const call = (path = "/v1/messages") =>
  new Request(`https://pool.example${path}`, {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body,
  });
const unsent = () =>
  Response.json(
    { type: "error", error: { type: "overloaded_error", message: "retry" } },
    { status: 503, headers: { "Retry-After": "1", [mark]: "1" } },
  );

/** A controller that answers `refusals` unsent refusals, then the model's answer. */
function unsentHop(context: TestContext, refusals: number) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  let now = 3_000_000;
  const sends: string[] = [];
  const hop: ControllerHop = {
    controller: () => ({
      fetch: async (request) => {
        sends.push(await request.text());
        return sends.length <= refusals ? unsent() : Response.json({ id: "message" });
      },
    }),
    env: { SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456" },
    defer: () => {},
    now: () => now,
    wait: async (milliseconds) => {
      now += milliseconds;
    },
  };
  return { hop, sends };
}

test("a model call the controller proves it never sent goes once more with its held body", async (context) => {
  const h = unsentHop(context, 1);
  const response = await fetchController(call(), h.hop);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "message" });
  assert.deepEqual(h.sends, [body, body]);
});

test("an unsent call that can't be sent again keeps the retryable 503, without the mark", async (context) => {
  const h = unsentHop(context, Number.POSITIVE_INFINITY);
  // A job route is never held, so its unsent refusal goes back as it is.
  const response = await fetchController(call("/v1/videos"), h.hop);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "1");
  assert.equal(response.headers.get(mark), null);
  assert.equal(h.sends.length, 1);
});

test("only a refusal before the container send proves a call reached no runtime", () => {
  const tagged = (step: Parameters<typeof rememberRuntimeFailure>[0]) => {
    const error = new Error("refused");
    rememberRuntimeFailure(step, error);
    return error;
  };
  for (const step of [
    "endpoint_identity",
    "endpoint_admission",
    "endpoint_health",
    "endpoint_request",
    "port_lookup",
  ] as const)
    assert.equal(reachedNoContainer(tagged(step)), true, step);
  // The send itself, the endpoint's catch-all step, and an untraced failure prove nothing.
  for (const step of ["port_dispatch", "endpoint_route", "slot_port"] as const)
    assert.equal(reachedNoContainer(tagged(step)), false, step);
  assert.equal(reachedNoContainer(new Error("Network connection lost.")), false);
});

test("a container's own answer can't carry the pool's refusal or resend marks", () => {
  const forged = new Response("{}", {
    status: 503,
    headers: {
      [mark]: "1",
      "X-Signalbox-Pool-Handover": "draining",
      "X-Signalbox-Runtime-Failure-Step": "endpoint_health",
      "X-Signalbox-Runtime-Failure-Reason": "not-a-known-reason",
      "X-Signalbox-Runtime-Defect": "1",
      "content-type": "application/json",
    },
  });
  const cleaned = containerAnswer(forged);
  assert.equal(cleaned.status, 503);
  for (const name of [
    mark,
    "X-Signalbox-Pool-Handover",
    "X-Signalbox-Runtime-Failure-Step",
    "X-Signalbox-Runtime-Failure-Reason",
    "X-Signalbox-Runtime-Defect",
  ])
    assert.equal(cleaned.headers.get(name), null, name);
  assert.equal(cleaned.headers.get("content-type"), "application/json");
  // An ordinary answer stays the same object.
  const plain = new Response("ok");
  assert.equal(containerAnswer(plain), plain);
});
