import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { monitorEventLoopDelay } from "node:perf_hooks";
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let settings = { rate: 1, contentBytes: 512, durationMs: 60000, phase: "control" },
  active = 0,
  peak = 0;
const operations = new Map(),
  evidence = createWriteStream("/evidence/upstream.ndjson", { flags: "a" });
let evidenceError = null;
evidence.on("error", (error) => {
  evidenceError = error.name;
});
const log = (value) => evidence.write(JSON.stringify(value) + "\n");
createServer(async (req, res) => {
  if (req.url === "/stats")
    return res.end(
      JSON.stringify({
        active,
        peak,
        operations: operations.size,
        cpu: process.cpuUsage(),
        rss: process.memoryUsage().rss,
        lagP99Ms: loop.percentile(99) / 1e6,
        lagMaxMs: loop.max / 1e6,
        evidencePendingBytes: evidence.writableLength,
        evidenceError,
      }),
    );
  if (req.url === "/flush") {
    await new Promise((resolve, reject) =>
      evidence.write("", (error) => (error ? reject(error) : resolve())),
    );
    return res.end("{}");
  }
  let raw = "";
  for await (const c of req) raw += c;
  if (req.url === "/settings") {
    settings = { ...settings, ...JSON.parse(raw) };
    peak = active;
    loop.reset();
    return res.end("{}");
  }
  if (req.url === "/v1/models")
    return res.end(JSON.stringify({ data: [{ id: "density-synthetic", object: "model" }] }));
  if (req.url !== "/v1/chat/completions") return res.writeHead(404).end();
  const id = raw.match(/density-op-[a-zA-Z0-9-]+/)?.[0];
  if (!id || operations.has(id)) {
    log({ event: "invalid-or-duplicate", id, at: Date.now() });
    return res.writeHead(409).end();
  }
  const s = { ...settings },
    record = {
      id,
      phase: s.phase,
      startedAt: Date.now(),
      rate: s.rate,
      contentBytes: s.contentBytes,
      durationMs: s.durationMs,
    };
  operations.set(id, record);
  active++;
  peak = Math.max(peak, active);
  let completed = false,
    count = 0,
    backpressure = 0,
    bufferMax = 0;
  log({ event: "start", ...record, active });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const write = (delta, finish = null) => {
    const chunk = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(record.startedAt / 1000),
      model: "density-synthetic",
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (!res.write("data: " + JSON.stringify(chunk) + "\n\n")) backpressure++;
    bufferMax = Math.max(bufferMax, res.writableLength);
  };
  write({ role: "assistant" });
  const tick = () => {
    count++;
    write({ content: "x".repeat(s.contentBytes) });
  };
  tick();
  const timer = setInterval(() => {
    if (count >= (s.durationMs * s.rate) / 1000) {
      clearInterval(timer);
      write({}, "stop");
      completed = true;
      res.end("data: [DONE]\n\n");
    } else tick();
  }, 1000 / s.rate);
  res.once("close", () => {
    clearInterval(timer);
    active--;
    log({
      event: "end",
      id,
      phase: s.phase,
      endedAt: Date.now(),
      completed,
      count,
      textBytes: count * s.contentBytes,
      backpressure,
      bufferMax,
      active,
    });
  });
}).listen(8080, "0.0.0.0");
