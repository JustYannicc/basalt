/**
 * The stage-1 checks against a deployed scratch stage. They drive the real receiver, gateway object
 * and pool route peer over the public workers.dev origin, signed with the run's own key, and report
 * only pass or fail per check: no reading, link, name or address reaches the log.
 */
import { createHash, randomBytes } from "node:crypto";
import { signEnvelope } from "../../src/pool/token.ts";
import { harnessPurpose, scratchAccount, scratchOwner, scratchRoute } from "./identity.ts";

export interface CheckOptions {
  readonly origin: string;
  readonly key: string;
  /** How long an open tunnel sits idle before it must still carry bytes. */
  readonly idleMs: number;
}

type Reply = { status: number; body: Record<string, unknown> };
const routed = (reply: Reply) =>
  (reply.body.reading as { state?: string } | undefined)?.state === "active";

export async function runChecks({ origin, key, idleMs }: CheckOptions) {
  // The checks call only the scratch stage's own Worker, nothing else on workers.dev or beyond.
  const target = new URL(origin);
  if (
    !/^basalt-route-scratch-[12]-pool\.[a-z0-9-]+\.workers\.dev$/u.test(target.hostname) ||
    target.protocol !== "https:" ||
    target.port ||
    target.username ||
    target.password ||
    target.pathname !== "/"
  )
    throw new Error("Refusing a target outside the scratch stage");
  const results: Record<string, boolean> = {};
  const check = async (name: string, work: () => Promise<boolean>) => {
    try {
      results[name] = await work();
    } catch {
      results[name] = false;
    }
    console.log(JSON.stringify({ check: name, passed: results[name] }));
  };

  async function acquire(action: string, extra: object = {}): Promise<Reply> {
    const at = Date.now();
    const person = ["start", "status", "cancel"].includes(action)
      ? { owner: scratchOwner }
      : scratchAccount;
    const claims = {
      routeId: scratchRoute,
      at,
      expiresAt: at + 25_000,
      action,
      ...person,
      ...extra,
    };
    const response = await fetch(`${origin}/route/v1/acquisitions`, {
      method: "POST",
      body: JSON.stringify({ envelope: await signEnvelope(key, "sbra1", claims) }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }
  async function harness(path: string, scheme: "ws" | "http" = "ws") {
    const at = Date.now();
    const auth = await signEnvelope(key, harnessPurpose, { at, expiresAt: at + 25_000 });
    return `${origin.replace(/^https?/u, scheme === "ws" ? "wss" : "https")}${path}?auth=${encodeURIComponent(auth)}`;
  }

  await check("the stage answers", async () => {
    // A fresh workers.dev name can take a moment to route; the receiver's own refusal proves it does.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await fetch(`${origin}/route/v1/acquisitions`, {
        method: "POST",
        body: "{}",
        signal: AbortSignal.timeout(10_000),
      }).catch(() => undefined);
      const body = (await response?.json().catch(() => undefined)) as
        | { error?: string }
        | undefined;
      if (response?.status === 400 && body?.error === "bad_request") return true;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  });
  if (!results["the stage answers"]) return results;
  await check("sign-in link issued", async () => {
    const start = await acquire("start", { app: "tailscale" });
    return start.status === 200 && typeof start.body.url === "string";
  });
  await check("sign-in completes", async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const status = await acquire("status");
      if (status.body.state === "connected") return true;
      if (status.body.state !== "waiting") return false;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    return false;
  });
  await check("exit selected and routed", async () => {
    const select = await acquire("select", { exitId: "n1", whenDown: "stop" });
    const reading = await acquire("reading");
    return select.status === 200 && routed(select) && routed(reading);
  });
  await check("exits listed", async () => {
    const exits = await acquire("exits");
    return exits.status === 200 && Array.isArray(exits.body.exits);
  });
  await check("50 MB both ways, byte-exact", async () => {
    const sent = randomBytes(50 * 1024 * 1024);
    const t = await echoTunnel(await harness(`/peer/${scratchRoute}`));
    const [, back] = await Promise.all([t.write(sent), t.read(sent.length)]);
    t.fin();
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    return digest(back) === digest(sent);
  });
  await check("an idle tunnel still carries bytes", async () => {
    const t = await echoTunnel(await harness(`/peer/${scratchRoute}`));
    await new Promise((resolve) => setTimeout(resolve, idleMs));
    const probe = randomBytes(1024);
    await t.write(probe);
    const echoed = (await t.read(1024)).equals(probe);
    t.fin();
    return echoed;
  });
  await check("a restart keeps the identity, with no new approval", async () => {
    const kill = await fetch(await harness("/kill", "http"), {
      signal: AbortSignal.timeout(60_000),
    });
    await kill.body?.cancel();
    const reading = await acquire("reading");
    const status = await acquire("status");
    return kill.ok && routed(reading) && status.body.state === "connected";
  });
  await check("an unassigned route is refused with 1008", async () => {
    const stranger = tunnel(await harness(`/peer/rt_${"z".repeat(26)}`));
    return (await stranger.closed).code === 1008;
  });
  await check("a pool without the class is refused with 1013", async () => {
    const bare = tunnel(await harness(`/bare/${scratchRoute}`));
    return (await bare.closed).code === 1013;
  });
  await check("disconnect is accepted", async () => (await acquire("remove")).status === 200);
  return results;
}

/** The Home peer relay wire from the pool's side: credit-limited binary frames plus fin. */
function tunnel(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let credit = 0;
  const inbox: Buffer[] = [];
  let buffered = 0;
  let finished = false;
  const waiters: Array<() => void> = [];
  const wake = () => waiters.splice(0).forEach((resolve) => resolve());
  const closed = new Promise<{ code: number }>((resolve) =>
    socket.addEventListener("close", (event) => {
      finished = true;
      wake();
      resolve({ code: event.code });
    }),
  );
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      const message = JSON.parse(event.data) as { credit?: number; fin?: boolean };
      if (message.credit) credit += message.credit;
      if (message.fin) finished = true;
    } else {
      const bytes = Buffer.from(event.data as ArrayBuffer);
      inbox.push(bytes);
      buffered += bytes.byteLength;
      socket.send(JSON.stringify({ credit: bytes.byteLength }));
    }
    wake();
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ credit: 65_536 }));
      resolve();
    });
    socket.addEventListener("error", () => reject(new Error("tunnel error")));
  });
  const next = () => new Promise<void>((resolve) => waiters.push(resolve));
  return {
    opened,
    closed,
    async write(bytes: Buffer) {
      for (let offset = 0; offset < bytes.length;) {
        while (!credit) {
          if (finished) throw new Error("tunnel closed");
          await next();
        }
        const size = Math.min(credit, 16_384, bytes.length - offset);
        socket.send(Uint8Array.from(bytes.subarray(offset, offset + size)));
        credit -= size;
        offset += size;
      }
    },
    async read(count: number) {
      while (buffered < count && !finished) await next();
      const all = Buffer.concat(inbox.splice(0));
      const rest = all.subarray(count);
      if (rest.length) inbox.push(rest);
      buffered = rest.length;
      return all.subarray(0, count);
    },
    fin: () => socket.send(JSON.stringify({ fin: true })),
  };
}

/** A tunnel through the stand-in's SOCKS port to the echo it serves itself. */
async function echoTunnel(url: string) {
  const t = tunnel(url);
  await t.opened;
  await t.write(Buffer.from([5, 1, 0]));
  if (!(await t.read(2)).equals(Buffer.from([5, 0]))) throw new Error("socks greeting");
  const host = Buffer.from("echo.invalid");
  await t.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 7])]));
  const reply = await t.read(10);
  if (reply[1] !== 0) throw new Error("socks refused");
  return t;
}
