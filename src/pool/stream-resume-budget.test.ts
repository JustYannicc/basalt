import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { resumeLayerPort, toLayer } from "./stream-resume.ts";

// Its own file: the resend copies' budget is one count per isolate, so no other test may share it.
const kept = 4 * 1024 * 1024;
/** How long a kept copy can still be re-sent. */
const spareWindowMs = 20_000;
const marked = () =>
  new Request("http://pool/v1/responses", {
    method: "POST",
    headers: { "X-Basalt-Resumable": "1", "Content-Length": String(kept) },
    body: '{"model":"m"}',
  });
const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

/** Every copy `toLayer` keeps, so a test can see whether its bytes were let go. */
function copies(context: TestContext) {
  const made: Request[] = [];
  const clone = Request.prototype.clone;
  context.mock.method(Request.prototype, "clone", function (this: Request) {
    const copy = clone.call(this);
    made.push(copy);
    return copy;
  });
  return made;
}

test("a copy whose window has passed is never sent: a late unreachable answer is the node's failure", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000_000 });
  const ports: number[] = [];
  let answer: (response: Response) => void = () => {};
  const pending = toLayer(marked(), (_request, port) => {
    ports.push(port);
    return port === resumeLayerPort
      ? new Promise<Response>((resolve) => (answer = resolve))
      : Promise.resolve(new Response("node"));
  });
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(spareWindowMs);
  answer(
    new Response("{}", { status: 502, headers: { "X-Basalt-Resume-Upstream": "unreachable" } }),
  );
  await assert.rejects(pending, /Pool node unreachable/);
  assert.deepEqual(ports, [resumeLayerPort]);
});

test("a send that never settles lets its copy go and gives its budget share back once the window has passed", async (context) => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000_000 });
  const made = copies(context);
  // Eight calls the layer never answers keep the whole 32 MiB budget.
  for (let call = 0; call < 8; call++)
    void toLayer(marked(), () => new Promise<Response>(() => {}));
  assert.equal(made.length, 8);
  assert.ok(made.every((copy) => !copy.bodyUsed));
  const ports: number[] = [];
  const send = async (_request: Request, port: number) => {
    ports.push(port);
    if (port === resumeLayerPort) throw refused();
    return new Response("node");
  };
  // Inside the window the budget is full: no copy, so a refused connect is the layer's failure.
  await assert.rejects(toLayer(marked(), send), /ECONNREFUSED/);
  assert.deepEqual(ports, [resumeLayerPort]);

  // Past it the stuck copies are let go, not only uncounted, and a refused connect goes on.
  context.mock.timers.tick(spareWindowMs);
  assert.ok(
    made.every((copy) => copy.bodyUsed),
    "a lapsed copy's bytes are let go",
  );
  ports.length = 0;
  const answer = await toLayer(marked(), send);
  assert.equal(await answer.text(), "node");
  assert.deepEqual(ports, [resumeLayerPort, 8317]);
});
