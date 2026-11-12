import { Schema } from "effect";
import bundle from "../home-peer-program.json" with { type: "json" };
import { SlotIdentity, SlotRefused, sameIdentity } from "./contract.ts";
import type { ControllerState } from "./runtime-state.ts";

const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Record = Schema.Struct({
  operationId: Schema.String,
  nonce: Schema.String,
  identity: SlotIdentity,
  configurationFingerprint: Digest,
  sourceSha: Digest,
  state: Schema.Literals(["started", "ready"]),
  hostPid: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
});
const Witness = Schema.Struct({
  sourceSha: Digest,
  nonce: Schema.String,
  bootId: Schema.String,
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  startTicks: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  ready: Schema.Boolean,
});
export interface PeerBootstrapInput {
  operationId: string;
  identity: SlotIdentity;
  configurationFingerprint: string;
  sourceSha: string;
}

export const peerBootstrapInspectionProgram = `import hashlib,json,pathlib,signal,sys
signal.alarm(2)
path=pathlib.Path('/dev/shm/cliproxy-pool/home-peer-start.json')
if not path.exists():
 print(json.dumps({'live':False}));sys.exit(0)
if path.stat().st_size>2048: raise RuntimeError('peer witness too large')
record=json.loads(path.read_text())
pid=record['pid']
if type(pid) is not int or pid<1: raise RuntimeError('invalid peer process')
try:
 stat=pathlib.Path('/proc/'+str(pid)+'/stat').read_text()
 fields=stat[stat.rfind(')')+2:].split()
 argv=pathlib.Path('/proc/'+str(pid)+'/cmdline').read_bytes().split(b'\\0')
 live=(fields[0]!='Z' and fields[19]==record['startTicks'] and len(argv)>=4
       and hashlib.sha256(argv[2]).hexdigest()==record['sourceSha']
       and json.loads(argv[3])=={key:record[key] for key in ('sourceSha','nonce','bootId')})
except FileNotFoundError:
 live=False
print(json.dumps({'live':live,'witness':record},separators=(',',':')))
`;

/** The durable intent precedes exec. Every later call only inspects this exact helper. */
export class PeerBootstrap {
  private ctx: ControllerState;
  private health: (identity: SlotIdentity, signal: AbortSignal) => Promise<unknown>;
  constructor(ctx: ControllerState, health: PeerBootstrap["health"]) {
    this.ctx = ctx;
    this.health = health;
  }
  private key(identity: SlotIdentity) {
    return `home-peer-bootstrap-v1:${JSON.stringify([identity.instanceId, identity.bootId])}`;
  }
  private bound(record: typeof Record.Type, input: PeerBootstrapInput) {
    if (
      !sameIdentity(record.identity, input.identity) ||
      record.operationId !== input.operationId ||
      record.sourceSha !== input.sourceSha ||
      record.configurationFingerprint !== input.configurationFingerprint
    )
      throw new SlotRefused("identity");
  }
  async run(input: PeerBootstrapInput, signal: AbortSignal) {
    await this.health(input.identity, signal);
    signal.throwIfAborted();
    const retained = await this.ctx.storage.transaction(async (transaction) => {
      const previous = await transaction.get(this.key(input.identity));
      if (previous !== undefined) {
        const record = Schema.decodeUnknownSync(Record)(previous);
        this.bound(record, input);
        return { record, start: false };
      }
      if (input.sourceSha !== bundle.sourceSha) throw new SlotRefused("identity");
      const record = Schema.decodeUnknownSync(Record)({
        ...input,
        nonce: crypto.randomUUID(),
        state: "started",
      });
      await transaction.put(this.key(input.identity), record);
      return { record, start: true };
    });
    let hostPid: number | undefined;
    if (retained.start) {
      try {
        signal.throwIfAborted();
        const container = this.ctx.container;
        if (!container?.exec) throw new SlotRefused("uncertain");
        const process = await container.exec(
          [
            "python3",
            "-c",
            bundle.program,
            JSON.stringify({
              sourceSha: bundle.sourceSha,
              nonce: retained.record.nonce,
              bootId: input.identity.bootId,
            }),
          ],
          { stdout: "pipe", stderr: "ignore" },
        );
        hostPid = process.pid;
        if (hostPid !== undefined) {
          await this.ctx.storage.transaction(async (transaction) => {
            const saved = Schema.decodeUnknownSync(Record)(
              await transaction.get(this.key(input.identity)),
            );
            this.bound(saved, input);
            await transaction.put(this.key(input.identity), { ...saved, hostPid });
          });
        }
        if (!process.stdout) throw new SlotRefused("uncertain");
        await this.acknowledge(process.stdout, retained.record, signal);
      } catch {
        // A failed exec response does not establish whether a helper started.
      }
    }
    return this.inspect(retained.record, signal, hostPid);
  }
  private async acknowledge(
    stream: ReadableStream<Uint8Array>,
    record: typeof Record.Type,
    signal: AbortSignal,
  ) {
    const reader = stream.getReader();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    deadline.addEventListener("abort", cancel, { once: true });
    let text = "";
    try {
      while (!text.includes("\n")) {
        deadline.throwIfAborted();
        const next = await reader.read();
        if (next.done) throw new SlotRefused("uncertain");
        text += new TextDecoder().decode(next.value);
        if (text.length > 2048) throw new SlotRefused("uncertain");
      }
      const witness = Schema.decodeUnknownSync(Witness)(JSON.parse(text));
      if (
        !witness.ready ||
        witness.sourceSha !== record.sourceSha ||
        witness.nonce !== record.nonce ||
        witness.bootId !== record.identity.bootId
      )
        throw new SlotRefused("identity");
    } finally {
      deadline.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
    }
  }
  private async inspect(record: typeof Record.Type, signal: AbortSignal, hostPid?: number) {
    try {
      await this.health(record.identity, signal);
      signal.throwIfAborted();
      const container = this.ctx.container;
      if (!container?.exec) throw new SlotRefused("uncertain");
      const output = await (
        await container.exec(["python3", "-c", peerBootstrapInspectionProgram])
      ).output();
      if (output.exitCode !== 0 || output.stderr.byteLength || output.stdout.byteLength > 4096)
        throw new SlotRefused("uncertain");
      const observation = Schema.decodeUnknownSync(
        Schema.Struct({ live: Schema.Boolean, witness: Schema.optional(Witness) }),
      )(JSON.parse(new TextDecoder().decode(output.stdout)));
      const witness = observation.witness;
      if (
        !observation.live ||
        !witness?.ready ||
        witness.nonce !== record.nonce ||
        witness.sourceSha !== record.sourceSha ||
        witness.bootId !== record.identity.bootId
      )
        throw new SlotRefused("uncertain");
      await this.health(record.identity, signal);
      signal.throwIfAborted();
      const current = await this.ctx.storage.transaction(async (transaction) => {
        const saved = Schema.decodeUnknownSync(Record)(
          await transaction.get(this.key(record.identity)),
        );
        this.bound(saved, record);
        const ready = { ...saved, state: "ready" as const, ...(hostPid ? { hostPid } : {}) };
        await transaction.put(this.key(record.identity), ready);
        return ready;
      });
      return { ...current, observation: "ready" as const, witness };
    } catch {
      return { ...record, observation: "unknown" as const };
    }
  }
}
