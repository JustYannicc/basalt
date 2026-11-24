import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { fetchController, type ControllerHop } from "./controller-reset.ts";
import { nativeModelHeader, nativeModelPrefix } from "./native-contract.ts";
import { openEnvelope, signEnvelope } from "./token.ts";
import { nativeRuntimeStream } from "./runtime-unavailable.ts";
import { runtimeFailureDiagnostic } from "./runtime-route-diagnostic.ts";
import { RuntimeChannel } from "./runtime-slots/channel.ts";
import { SlotRefused } from "./runtime-slots/contract.ts";
import {
  layerConnectRefused,
  resumeLayerPort,
  resumeRoute,
  toLayer,
  decodeResumeInput,
  decodeResumeTarget,
  encodeResumeTarget,
  resumableAnswer,
  stampResumeTarget,
  streamResumeAttempts,
  streamResumeWindowMs,
  type StreamResumeInput,
} from "./stream-resume.ts";

const requestId = "0b5c3a4e-8f1d-4c2b-9a7e-3d6f1e2a4b5c";
const encoder = new TextEncoder();
const ended = () =>
  Object.assign(
    new Error(
      "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    ),
    { retryable: true },
  );
const first = 'event: message_start\ndata: {"type":"message_start"}\n\n';
const delta = (text: string) =>
  `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"${text}"}}\n\n`;
const rest = `${delta("rest")}event: message_stop\ndata: {"type":"message_stop"}\n\n`;

/** A body that sends `chunks` and then fails the way an ended controller instance does. */
function cutBody(chunks: string[]) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length) controller.enqueue(encoder.encode(chunks[sent++]!));
      else controller.error(ended());
    },
  });
}
const resumableHeaders = (extra: Record<string, string> = {}) => ({
  "content-type": "text/event-stream",
  "X-Request-Id": requestId,
  "X-Basalt-Resume": "v1",
  "X-Basalt-Resume-Target": "primary",
  "X-Signalbox-Pool-Boot": "boot-1",
  ...extra,
});
const call = () =>
  new Request("https://pool.example/v1/messages", {
    method: "POST",
    headers: { "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-opus-5-5", messages: [] }),
  });

/** A controller that answers once with `answer`, and resumes with `resume`. */
function hop(
  context: TestContext,
  answer: () => Response,
  resume?: (input: StreamResumeInput) => Promise<Response>,
) {
  context.mock.method(console, "info", () => {});
  context.mock.method(console, "error", () => {});
  let now = 1_000_000;
  const resumes: StreamResumeInput[] = [];
  const waits: number[] = [];
  const value: ControllerHop = {
    controller: () => ({
      fetch: async () => answer(),
      ...(resume
        ? {
            resume: (input: StreamResumeInput) => {
              resumes.push(input);
              return resume(input);
            },
          }
        : {}),
    }),
    env: {},
    defer: () => {},
    now: () => now,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
  };
  return { hop: value, resumes, waits, advance: (ms: number) => (now += ms) };
}
const read = async (response: Response) => new TextDecoder().decode(await response.arrayBuffer());

test("an answer the front layer did not mark is returned untouched, so the cut ends exactly as today", async (context) => {
  const plain = new Response(cutBody([first]), {
    headers: { "content-type": "text/event-stream", "X-Request-Id": requestId },
  });
  const deps = {
    resume: async () => assert.fail("never resumed"),
    ended: () => true,
    wait: async () => {},
    now: () => 0,
    delayMs: 1_000,
    signal: new AbortController().signal,
  };
  assert.equal(resumableAnswer(plain, deps), plain);
  // Today's bytes: the same cut stream through today's terminal wrapper alone.
  const today = await read(
    nativeRuntimeStream(new Response(cutBody([first]), { headers: plain.headers }), call()),
  );
  const h = hop(
    context,
    () =>
      new Response(cutBody([first]), {
        headers: { "content-type": "text/event-stream", "X-Request-Id": requestId },
      }),
  );
  assert.equal(await read(await fetchController(call(), h.hop)), today);
  assert.deepEqual(h.resumes, []);
});

test("a cut answer is re-attached from the delivered offset and spliced, with no error event", async (context) => {
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async (input) =>
      new Response(rest, {
        headers: {
          "X-Basalt-Resume": "v1",
          "X-Basalt-Resume-From": String(input.from),
          "X-Basalt-Resume-State": "live",
        },
      }),
  );
  const response = await fetchController(call(), h.hop);
  assert.equal(await read(response), first + rest);
  assert.deepEqual(h.resumes, [
    {
      requestId,
      from: encoder.encode(first).byteLength,
      target: "primary",
      boot: "boot-1",
      // The call as its caller made it, for the controller to admit again; the upload's framing
      // is not part of who made it.
      call: {
        method: "POST",
        path: "/v1/messages",
        headers: [["anthropic-version", "2023-06-01"]],
      },
    },
  ]);
  assert.deepEqual(h.waits, [1_000]);
  assert.equal(
    response.headers.get("X-Basalt-Resume-Target"),
    null,
    "internal headers stay inside",
  );
});

test("an answer that is gone ends with today's retry terminal, byte for byte", async (context) => {
  const today = await read(
    nativeRuntimeStream(
      new Response(cutBody([first]), { headers: { "content-type": "text/event-stream" } }),
      call(),
    ),
  );
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async () => new Response(null, { status: 410, headers: { "X-Basalt-Resume-State": "gone" } }),
  );
  assert.equal(await read(await fetchController(call(), h.hop)), today);
  assert.equal(h.resumes.length, 1);
});

test("a new instance that is not up yet is asked again, at most three times within the window", async (context) => {
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async () => {
      throw ended();
    },
  );
  const text = await read(await fetchController(call(), h.hop));
  assert.ok(text.startsWith(first));
  assert.match(text, /The model runtime restarted/);
  assert.equal(h.resumes.length, streamResumeAttempts);
  assert.deepEqual(h.waits, [1_000, 1_000, 1_000]);
});

test("a second cut during a resumed answer is resumed again from the new offset", async (context) => {
  const middle = delta("mid");
  let resumes = 0;
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async (input) => {
      resumes++;
      return new Response(resumes === 1 ? cutBody([middle]) : rest, {
        headers: { "X-Basalt-Resume": "v1", "X-Basalt-Resume-From": String(input.from) },
      });
    },
  );
  assert.equal(await read(await fetchController(call(), h.hop)), first + middle + rest);
  assert.deepEqual(
    h.resumes.map((input) => input.from),
    [encoder.encode(first).byteLength, encoder.encode(first + middle).byteLength],
  );
});

test("an older controller without the resume method, or a mismatched offset, falls back to today", async (context) => {
  const today = await read(
    nativeRuntimeStream(
      new Response(cutBody([first]), { headers: { "content-type": "text/event-stream" } }),
      call(),
    ),
  );
  const old = hop(context, () => new Response(cutBody([first]), { headers: resumableHeaders() }));
  assert.equal(await read(await fetchController(call(), old.hop)), today);
  const shifted = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async () =>
      new Response(rest, { headers: { "X-Basalt-Resume": "v1", "X-Basalt-Resume-From": "0" } }),
  );
  assert.equal(await read(await fetchController(call(), shifted.hop)), today);
});

test("resume targets and inputs decode only in their closed forms", () => {
  const identity = {
    format: "pool-runtime-slot-v1" as const,
    controllerId: "a".repeat(64),
    slotId: "slot-1",
    applicationId: "application-1",
    applicationVersion: "version-1",
    instanceId: "instance-1",
    imageDigest: `sha256:${"b".repeat(64)}`,
    imageInput: "input-1",
    bootId: "boot-2",
  };
  assert.deepEqual(decodeResumeTarget(encodeResumeTarget({ kind: "runtime", identity })), {
    kind: "runtime",
    identity,
  });
  assert.deepEqual(decodeResumeTarget("primary"), { kind: "primary" });
  for (const bad of ["", "runtime:", "runtime:!!", "secondary", 7, null]) {
    assert.equal(decodeResumeTarget(bad), undefined);
  }
  const good = { requestId, from: 12, target: "primary", boot: "boot-1" };
  assert.ok(decodeResumeInput(good));
  for (const bad of [
    { ...good, requestId: "not-a-uuid" },
    { ...good, from: -1 },
    { ...good, from: 1.5 },
    { ...good, boot: "" },
    { ...good, target: "elsewhere" },
    null,
  ])
    assert.equal(decodeResumeInput(bad), undefined);
});

test("only an answer the front layer marked is stamped with the runtime that served it", () => {
  const plain = new Response("x");
  assert.equal(stampResumeTarget(plain, { kind: "primary" }), plain);
  const marked = stampResumeTarget(new Response("x", { headers: { "X-Basalt-Resume": "v1" } }), {
    kind: "primary",
  });
  assert.equal(marked.headers.get("X-Basalt-Resume-Target"), "primary");
});

test("only a container that advertises the layer gets marked calls and resume reads", () => {
  const call = (headers: Record<string, string> = {}) =>
    new Request("http://pool/v1/responses", { method: "POST", headers, body: "{}" });
  const eligible = { "X-Basalt-Resume-Eligible": "1" };
  const advert = { resume: "v1" as const };
  const route = (request: Request, port: 8317 | 8327, status?: { resume?: "v1" }) => {
    const routed = resumeRoute(request, port, status);
    assert.notEqual(routed, "gone");
    if (routed === "gone") throw new Error("unreachable");
    return {
      port: routed.port,
      marked: routed.request.headers.get("X-Basalt-Resumable"),
      eligible: routed.request.headers.get("X-Basalt-Resume-Eligible"),
    };
  };
  assert.deepEqual(route(call(eligible), 8317, {}), { port: 8317, marked: null, eligible: null });
  assert.deepEqual(route(call(eligible), 8317, undefined), {
    port: 8317,
    marked: null,
    eligible: null,
  });
  assert.deepEqual(route(call(eligible), 8317, advert), {
    port: resumeLayerPort,
    marked: "1",
    eligible: null,
  });
  // A call the controller did not deem eligible, or one for another port, is never marked.
  assert.deepEqual(route(call({ "X-Basalt-Resumable": "1" }), 8317, advert), {
    port: 8317,
    marked: null,
    eligible: null,
  });
  assert.deepEqual(route(call(eligible), 8327, advert), {
    port: 8327,
    marked: null,
    eligible: null,
  });
  const resume = new Request(`http://pool/__basalt/resume/v1/${requestId}`);
  assert.equal(resumeRoute(resume, 8317, {}), "gone");
  const toLayer = resumeRoute(resume, 8317, advert);
  assert.ok(toLayer !== "gone" && toLayer.port === resumeLayerPort);
});

test("a layer that died since the readiness read costs resumability only", async () => {
  const marked = () =>
    new Request("http://pool/v1/responses", {
      method: "POST",
      headers: { "X-Basalt-Resumable": "1", "Content-Length": "13" },
      body: '{"model":"m"}',
    });
  const refused = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
  assert.equal(layerConnectRefused(refused), true);
  assert.equal(layerConnectRefused(new Error("wrapped", { cause: refused })), true);
  assert.equal(layerConnectRefused(new Error("Network connection lost.")), false);
  // The platform's own shape for a container port with nothing listening: a message, no code.
  const notListening = new Error("The container is not listening in the TCP address 10.0.0.1:8316");
  assert.equal(layerConnectRefused(notListening), true);
  assert.equal(layerConnectRefused(new Error("wrapped", { cause: notListening })), true);

  // Refused: nothing was accepted, so the call goes on to the node unmarked, with its body.
  const sends: { port: number; marked: string | null; body: string }[] = [];
  const answer = await toLayer(marked(), async (request, port) => {
    sends.push({
      port,
      marked: request.headers.get("X-Basalt-Resumable"),
      body: await request.text(),
    });
    if (port === resumeLayerPort) throw refused;
    return new Response("from the node");
  });
  assert.equal(await answer.text(), "from the node");
  assert.deepEqual(sends, [
    { port: resumeLayerPort, marked: "1", body: '{"model":"m"}' },
    { port: 8317, marked: null, body: '{"model":"m"}' },
  ]);
  const ports: number[] = [];
  const unlistened = await toLayer(marked(), async (request, port) => {
    ports.push(port);
    if (port === resumeLayerPort) throw notListening;
    assert.equal(await request.text(), '{"model":"m"}');
    return new Response("node after a layer with nothing listening");
  });
  assert.equal(await unlistened.text(), "node after a layer with nothing listening");
  assert.deepEqual(ports, [resumeLayerPort, 8317]);

  // Any other failure is the layer's: never sent again, and never read as the runtime failing.
  const lost = new Error("Network connection lost.");
  let tries = 0;
  await assert.rejects(
    toLayer(marked(), async () => {
      tries++;
      throw lost;
    }),
    lost,
  );
  assert.equal(tries, 1);
  assert.equal(runtimeFailureDiagnostic(lost, "fleet_forward").runtimeStep, "resume_layer");

  // A layer that could not reach the node hands the call to the node's port, which answers as today.
  const viaNode: number[] = [];
  const fromNode = await toLayer(marked(), async (request, port) => {
    viaNode.push(port);
    if (port === resumeLayerPort)
      return new Response('{"error":"upstream unreachable"}', {
        status: 502,
        headers: { "X-Basalt-Resume-Upstream": "unreachable" },
      });
    assert.equal(request.headers.get("X-Basalt-Resumable"), null);
    return new Response("node answer");
  });
  assert.equal(await fromNode.text(), "node answer");
  assert.deepEqual(viaNode, [resumeLayerPort, 8317]);

  // The node took the call and failed before answering: the node's own failure, never re-sent.
  const failedPorts: number[] = [];
  const nodeFailed = await toLayer(marked(), async (_request, port) => {
    failedPorts.push(port);
    return new Response('{"error":"resume_layer_upstream_failed"}', {
      status: 502,
      headers: { "X-Basalt-Resume-Upstream": "failed" },
    });
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(nodeFailed instanceof Error);
  assert.deepEqual(failedPorts, [resumeLayerPort]);
  assert.equal(runtimeFailureDiagnostic(nodeFailed, "fleet_forward").runtimeStep, "port_dispatch");

  // A resume read the layer can't take is simply gone.
  const gone = await toLayer(
    new Request(`http://pool/__basalt/resume/v1/${requestId}`),
    async () => {
      throw refused;
    },
  );
  assert.equal(gone.status, 410);
});

test("on a runtime's endpoint, a stopped container is the runtime's failure and a silent layer port is not", async () => {
  const configuration = {
    databaseUrl: "postgresql://fixture@database.invalid/pool",
    signingKey: "ab".repeat(32),
    managementKey: "fixture-management-key",
    imageInput: "2".repeat(16),
    databaseOwner: "basalt_pool_owner" as const,
  };
  const notListening = new Error("The container is not listening in the TCP address 10.0.0.1:8316");
  const channel = (running: boolean, ports: number[]) =>
    new RuntimeChannel(
      {
        container: {
          running,
          getTcpPort: (port: number) => ({
            fetch: async () => {
              ports.push(port);
              if (port === resumeLayerPort)
                throw running ? notListening : new Error("Network connection lost.");
              return new Response("node answer");
            },
          }),
        },
      } as unknown as ConstructorParameters<typeof RuntimeChannel>[0],
      { POOL_APP_SIGNING_KEY: "cd".repeat(32) } as ConstructorParameters<typeof RuntimeChannel>[1],
    );
  const marked = () =>
    new Request("http://runtime/v1/messages", {
      method: "POST",
      headers: { "X-Basalt-Resumable": "1", "Content-Length": "13" },
      body: '{"model":"m"}',
    });

  // Nothing listens on the layer's port of a running container: the node answers, unmarked.
  const served: number[] = [];
  const running = channel(true, served);
  const answer = await toLayer(marked(), (request, port) =>
    running.fetch(configuration, request, port),
  );
  assert.equal(await answer.text(), "node answer");
  assert.deepEqual(served, [resumeLayerPort, 8317]);

  // A stopped container refuses as unhealthy at the node's step, so the fleet acts as today.
  const stopped = channel(false, []);
  const failure = await toLayer(marked(), (request, port) =>
    stopped.fetch(configuration, request, port),
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(failure instanceof SlotRefused);
  assert.equal(failure.reason, "unhealthy");
  assert.equal(runtimeFailureDiagnostic(failure, "fleet_forward").runtimeStep, "port_dispatch");
});

test("a stopped container on the layer's port is the runtime's failure, and an unknown or large body is never re-sent", async () => {
  const marked = (headers: Record<string, string> = {}) =>
    new Request("http://pool/v1/responses", {
      method: "POST",
      headers: { "X-Basalt-Resumable": "1", ...headers },
      body: '{"model":"m"}',
    });
  const notListening = () =>
    new Error("The container is not listening in the TCP address 10.0.0.1:8316");
  const ports: number[] = [];
  const failing = (error: Error) => async (_request: Request, port: number) => {
    ports.push(port);
    throw error;
  };
  const outcome = (pending: Promise<Response>) =>
    pending.then(
      () => undefined,
      (error: unknown) => error,
    );

  // Stopped: never re-sent, and left unclassified, so the hop reads it as on the node's port.
  const stopped = notListening();
  assert.equal(
    await outcome(toLayer(marked({ "Content-Length": "13" }), failing(stopped), () => false)),
    stopped,
  );
  assert.deepEqual(ports, [resumeLayerPort]);
  assert.equal(runtimeFailureDiagnostic(stopped, "primary_forward").runtimeStep, "primary_forward");

  // A body of unknown size, or above the kept-copy bound, is never re-sent: the layer's failure.
  const unkept: Record<string, string>[] = [{}, { "Content-Length": String(4 * 1024 * 1024 + 1) }];
  for (const headers of unkept) {
    ports.length = 0;
    const error = notListening();
    assert.equal(await outcome(toLayer(marked(headers), failing(error))), error);
    assert.deepEqual(ports, [resumeLayerPort]);
    assert.equal(runtimeFailureDiagnostic(error, "fleet_forward").runtimeStep, "resume_layer");
  }

  // An unreachable node with no copy to re-send is the node's own failure, sent once.
  ports.length = 0;
  const unreachable = await outcome(
    toLayer(marked(), async (_request, port) => {
      ports.push(port);
      return new Response("{}", {
        status: 502,
        headers: { "X-Basalt-Resume-Upstream": "unreachable" },
      });
    }),
  );
  assert.ok(unreachable instanceof Error);
  assert.deepEqual(ports, [resumeLayerPort]);
  assert.equal(runtimeFailureDiagnostic(unreachable, "fleet_forward").runtimeStep, "port_dispatch");
});

test("a resume read that gets no answer from the layer within the window is gone", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  const pending = toLayer(
    new Request(`http://pool/__basalt/resume/v1/${requestId}`),
    (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
          reject(request.signal.reason);
        });
      }),
  );
  context.mock.timers.tick(streamResumeWindowMs);
  assert.equal((await pending).status, 410);
  assert.ok(aborted);
});

test("a resume that never answers ends with today's error once the window has passed", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let asked = 0;
  const spliced = resumableAnswer(new Response(cutBody([first]), { headers: resumableHeaders() }), {
    resume: () => {
      asked++;
      return new Promise<Response>(() => {});
    },
    ended: () => true,
    wait: async () => {},
    now: () => 0,
    delayMs: 1_000,
    signal: new AbortController().signal,
  });
  const reader = spliced.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), first);
  const cut = reader.read();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(asked, 1);
  context.mock.timers.tick(streamResumeWindowMs);
  await assert.rejects(cut, /no longer active/);
  assert.equal(asked, 1);
});

test("a marked answer that can't be resumed reaches the client with nothing internal in it", () => {
  const deps = {
    resume: async () => assert.fail("never resumed"),
    ended: () => true,
    wait: async () => {},
    now: () => 0,
    delayMs: 1_000,
    signal: new AbortController().signal,
  };
  for (const answer of [
    new Response('{"type":"error"}', { status: 400, headers: resumableHeaders() }),
    new Response("data", { headers: resumableHeaders({ "X-Basalt-Resume-Target": "elsewhere" }) }),
  ]) {
    const delivered = resumableAnswer(answer, deps);
    assert.notEqual(delivered, answer);
    assert.equal(delivered.status, answer.status);
    for (const name of ["X-Basalt-Resume", "X-Basalt-Resume-Target", "X-Basalt-Resume-State"])
      assert.equal(delivered.headers.get(name), null, name);
    assert.equal(delivered.headers.get("X-Request-Id"), requestId);
  }
  // Only a successful answer is stamped with the runtime that served it.
  const failed = new Response(null, { status: 500, headers: { "X-Basalt-Resume": "v1" } });
  assert.equal(stampResumeTarget(failed, { kind: "primary" }), failed);
});

test("a client that leaves while a resume is asked for does not keep the resumed part open", async () => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let resumedCancelled = false;
  const spliced = resumableAnswer(new Response(cutBody([first]), { headers: resumableHeaders() }), {
    resume: async (input) =>
      new Response(
        new ReadableStream({
          cancel() {
            resumedCancelled = true;
          },
        }),
        { headers: { "X-Basalt-Resume": "v1", "X-Basalt-Resume-From": String(input.from) } },
      ),
    ended: () => true,
    wait: () => waiting,
    now: () => 0,
    delayMs: 1_000,
    signal: new AbortController().signal,
  });
  const reader = spliced.body!.getReader();
  await reader.read();
  const cut = reader.read().catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  await reader.cancel("client left").catch(() => {});
  release();
  await cut;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(resumedCancelled);
});

test("an answer whose resumed part fails before any byte is not resumed again", async (context) => {
  let resumes = 0;
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async (input) => {
      resumes++;
      return new Response(cutBody([]), {
        headers: { "X-Basalt-Resume": "v1", "X-Basalt-Resume-From": String(input.from) },
      });
    },
  );
  const text = await read(await fetchController(call(), h.hop));
  assert.ok(text.startsWith(first));
  assert.match(text, /The model runtime restarted/);
  assert.equal(resumes, 1);
});

test("a re-sent copy arrives whole when the node answers before reading it, and each call gives its share of the copy budget back", async () => {
  const marked = (size: number) =>
    new Request("http://pool/v1/responses", {
      method: "POST",
      headers: { "X-Basalt-Resumable": "1", "Content-Length": String(size) },
      body: '{"model":"m"}',
    });
  const refused = () =>
    new Error("The container is not listening in the TCP address 10.0.0.1:8316");
  // The node answers before it has read the body, as a node may: the upload must still arrive whole.
  let upload: Promise<string> | undefined;
  const answer = await toLayer(marked(13), async (request, port) => {
    if (port === resumeLayerPort) throw refused();
    upload = request.text();
    return new Response("node");
  });
  assert.equal(await answer.text(), "node");
  assert.equal(await upload, '{"model":"m"}');

  // Ten calls at the 4 MiB bound in turn all keep a copy: each gives its share of the budget back.
  let resent = 0;
  for (let call = 0; call < 10; call++) {
    const response = await toLayer(marked(4 * 1024 * 1024), async (request, port) => {
      if (port === resumeLayerPort) throw refused();
      resent++;
      await request.text();
      return new Response("node");
    });
    await response.text();
  }
  assert.equal(resent, 10);
});

test("the entry's own resume signs a device's assertion afresh, its claims unchanged", async (context) => {
  const key = "ab".repeat(32);
  const claims = {
    user: "person",
    grant: "native:grant",
    computer: "computer",
    pool: "pool",
    method: "POST",
    path: "/v1/messages",
  };
  // Signed long ago: a device answer outlasts the assertion's 25 s.
  const stale = await signEnvelope(key, nativeModelPrefix, { ...claims, expiresAt: 1 });
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async () => new Response(null, { status: 410, headers: { "X-Basalt-Resume-State": "gone" } }),
  );
  const device = new Request("https://pool.example/v1/messages", {
    method: "POST",
    headers: { [nativeModelHeader]: stale },
    body: "{}",
  });
  await read(await fetchController(device, { ...h.hop, signing: { key } }));
  const sent = new Headers(h.resumes[0]!.call!.headers).get(nativeModelHeader)!;
  const opened = (await openEnvelope(key, nativeModelPrefix, sent)) as Record<string, unknown>;
  const { expiresAt, ...rest } = opened;
  assert.deepEqual(rest, claims);
  assert.ok((expiresAt as number) > Date.now(), "a live assertion");
});

test("an entry whose own admission refuses the call does not resume it: today's retry terminal", async (context) => {
  const today = await read(
    nativeRuntimeStream(
      new Response(cutBody([first]), { headers: { "content-type": "text/event-stream" } }),
      call(),
    ),
  );
  const h = hop(
    context,
    () => new Response(cutBody([first]), { headers: resumableHeaders() }),
    async () => assert.fail("a refused caller is never resumed"),
  );
  const asked: string[] = [];
  const readmit = async (request: Request) => {
    asked.push(new URL(request.url).pathname);
    return false;
  };
  assert.equal(await read(await fetchController(call(), { ...h.hop, readmit })), today);
  assert.deepEqual(asked, ["/v1/messages"]);
  assert.deepEqual(h.resumes, []);
});
