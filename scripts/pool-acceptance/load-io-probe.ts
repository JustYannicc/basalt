import { createConnection, createServer, type Socket } from "node:net";
import { performance } from "node:perf_hooks";

/** How often the probe writes its byte. */
export const ioProbeIntervalMs = 20;

export interface IoProbe {
  /** Stops the probe and returns the longest wait it saw, or undefined when nothing was measured. */
  stop(): Promise<number | undefined>;
}

/**
 * How long a frame arriving on a socket could have waited to be read, measured on the driver's own
 * loop. A frame is read only when the loop next polls its sockets, and a block of the loop, or two
 * blocks with only a timer phase between them, holds every poll back. The probe writes one byte to
 * its own loopback socket every interval and notes when each byte is read, through the same kind of
 * socket callback the pool's answers use. A frame that arrives after byte k-1 was written is read
 * no later than byte k, the next one written after it, so the time from writing byte k-1 to reading
 * byte k bounds its wait, however callbacks are ordered within one poll. The longest such span (and
 * from the last write still unread to the stop) is the probe's answer. It is read raw and only ever
 * added to.
 */
export async function startIoProbe(now: () => number = () => performance.now()): Promise<IoProbe> {
  let receiver: Socket | undefined;
  const server = createServer((socket) => {
    receiver = socket;
    socket.on("data", (chunk: Buffer) => received(chunk.length));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("io probe has no port");
  const sender = createConnection({ host: "127.0.0.1", port: address.port });
  sender.setNoDelay(true);
  await new Promise<void>((resolve, reject) => {
    sender.once("connect", resolve);
    sender.once("error", reject);
  });

  // Write times of the bytes not yet read; the first is the write before the next byte to arrive.
  const written: number[] = [];
  let before: number | undefined;
  let longest = 0;
  let answered = false;
  const startedAt = now();
  let firstAnswer: () => void = () => {};
  const first = new Promise<void>((resolve) => (firstAnswer = resolve));
  function received(bytes: number) {
    const at = now();
    for (let index = 0; index < bytes && written.length; index++) {
      longest = Math.max(longest, at - (before ?? startedAt));
      before = written.shift();
    }
    if (!answered) {
      answered = true;
      firstAnswer();
    }
  }
  const byte = Buffer.from([1]);
  const write = () => {
    written.push(now());
    sender.write(byte);
  };
  const writer = setInterval(write, ioProbeIntervalMs);
  write();
  // The run starts only once a byte has come back, so the measurement covers it from its start.
  await Promise.race([first, new Promise((resolve) => setTimeout(resolve, 5_000))]);

  return {
    async stop() {
      // One more interval, so a block just before the stop shows as a gap that is closed by a poll.
      await new Promise((resolve) => setTimeout(resolve, ioProbeIntervalMs * 2));
      clearInterval(writer);
      const stoppedAt = now();
      // A byte still unread at the stop counts with its age, from the write before it.
      if (written.length) longest = Math.max(longest, stoppedAt - (before ?? startedAt));
      sender.destroy();
      receiver?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return answered ? Math.ceil(longest) : undefined;
    },
  };
}
