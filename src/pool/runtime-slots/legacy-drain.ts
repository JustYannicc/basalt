import { Schema } from "effect";
import { SlotRefused, SlotSelection, sameIdentity, type SlotIdentity } from "./contract.ts";
import type { ControllerState } from "./runtime-state.ts";
import { LegacyActivity } from "./legacy-activity.ts";
import { slotSelectionKey } from "./storage.ts";

// This closed read-only program inspects the existing listener, including upgraded sockets.
export const legacyDrainProgram = `import json,pathlib,signal
signal.alarm(2)
count=0
for name in ('tcp','tcp6'):
 with pathlib.Path('/proc/net/'+name).open('r') as source:
  if not source.readline(4096).strip().startswith('sl'): raise RuntimeError('invalid socket table')
  for index,line in enumerate(source):
   if index>=65536 or len(line)>4096: raise RuntimeError('socket table too large')
   columns=line.split()
   if len(columns)<10: raise RuntimeError('invalid socket row')
   if int(columns[1].rsplit(':',1)[1],16)==8317 and columns[3] not in ('0A','06'):
    count+=1
print(json.dumps({'format':'legacy-drain-v1','connections':count},separators=(',',':')))
`;

export interface DrainExecutor {
  exec(
    command: string[],
    options?: { stdout: "pipe"; stderr: "ignore" },
  ): Promise<{
    readonly pid?: number;
    readonly stdout?: ReadableStream<Uint8Array> | null;
    output(): Promise<{
      exitCode: number;
      stdout: ArrayBuffer | Uint8Array;
      stderr: ArrayBuffer | Uint8Array;
    }>;
  }>;
}

/** Zero counts require both IPv4 and IPv6 reads. A failed or truncated probe is unknown. */
export async function legacyConnections(container: DrainExecutor) {
  const command = await container.exec(["python3", "-c", legacyDrainProgram]);
  const output = await command.output();
  if (output.exitCode !== 0 || output.stderr.byteLength || output.stdout.byteLength > 128)
    throw new SlotRefused("uncertain");
  const result = Schema.decodeUnknownSync(
    Schema.Struct({
      format: Schema.Literal("legacy-drain-v1"),
      connections: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    }),
  )(JSON.parse(new TextDecoder().decode(output.stdout)));
  return result.connections;
}

/** Old images need an ingress observation after their durable selection stops new admissions. */
export async function proveLegacyDrain(
  ctx: ControllerState,
  identity: SlotIdentity,
  signal: AbortSignal,
  health: () => Promise<unknown>,
) {
  const check = async () => {
    const selection = Schema.decodeUnknownSync(SlotSelection)(
      await ctx.storage.get(slotSelectionKey),
    );
    if (
      !sameIdentity(selection.draining?.identity, identity) ||
      sameIdentity(selection.active.identity, identity) ||
      (await new LegacyActivity(ctx.storage).active())
    )
      throw new SlotRefused("draining");
  };
  await check();
  const container = ctx.container;
  if (!container?.exec) throw new SlotRefused("uncertain");
  if (await legacyConnections({ exec: container.exec.bind(container) })) return false;
  await health();
  await check();
  signal.throwIfAborted();
  return true;
}
