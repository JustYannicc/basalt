import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { readdir, readFile } from "node:fs/promises";
import { totalmem, freemem, loadavg } from "node:os";
import { Server, Socket } from "node:net";
import { Server as HttpServer } from "node:http";

const sockets = new Set();
const responses = new Set();
const track = (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
};
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  track(this);
  return connect.apply(this, args);
};
const emit = Server.prototype.emit;
Server.prototype.emit = function (event, ...args) {
  if (event === "connection") track(args[0]);
  return emit.call(this, event, ...args);
};
const httpEmit = HttpServer.prototype.emit;
HttpServer.prototype.emit = function (event, ...args) {
  if (event === "request") {
    responses.add(args[1]);
    args[1].once("close", () => responses.delete(args[1]));
  }
  if ((event === "request" || event === "upgrade") && args[0].headers["x-scale-id"])
    process.stderr.write(
      `SCALE_RECEIPT ${JSON.stringify({ id: args[0].headers["x-scale-id"], at: performance.timeOrigin + performance.now() })}\n`,
    );
  return httpEmit.call(this, event, ...args);
};
const loop = monitorEventLoopDelay({ resolution: 1 });
const all = monitorEventLoopDelay({ resolution: 1 });
all.enable();
loop.enable();
let previous = process.cpuUsage(),
  previousAt = performance.now(),
  sampling = false;
const limitText = await readFile("/proc/self/limits", "utf8").catch(() => "");
const fdLimit = Number(/Max open files\s+(\d+)/u.exec(limitText)?.[1] ?? 0);
const cgroupText = await readFile("/sys/fs/cgroup/memory.max", "utf8").catch(() => "max");
const memoryLimitBytes = /^\d+\s*$/u.test(cgroupText) ? Number(cgroupText) : totalmem();
const sample = async () => {
  if (sampling) return;
  sampling = true;
  try {
    const at = performance.now(),
      cpu = process.cpuUsage();
    const intervalMs = at - previousAt;
    const cpuRatio =
      (cpu.user + cpu.system - previous.user - previous.system) / (intervalMs * 1000);
    previous = cpu;
    previousAt = at;
    const memory = process.memoryUsage();
    const fds = await readdir("/proc/self/fd").catch(() => []);
    const value = {
      at: performance.timeOrigin + at,
      pid: process.pid,
      cpuRatio,
      intervalMs,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      memoryLimitBytes,
      hostFreeBytes: freemem(),
      fdLimit,
      fds: fds.length,
      sockets: sockets.size,
      readableBytes: [...sockets].reduce((sum, socket) => sum + socket.readableLength, 0),
      writableBytes: [...sockets].reduce((sum, socket) => sum + socket.writableLength, 0),
      httpBufferedBytes: [...responses].reduce((sum, response) => sum + response.writableLength, 0),
      loopP99Ms: loop.percentile(99) / 1e6,
      loopMaxMs: loop.max / 1e6,
      cumulativeLoopP99Ms: all.percentile(99) / 1e6,
      load1: loadavg()[0],
    };
    process.stderr.write(`SCALE_RESOURCE ${JSON.stringify(value)}\n`);
    loop.reset();
  } finally {
    sampling = false;
  }
};
setInterval(() => void sample(), 1000).unref();
