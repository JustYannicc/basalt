import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { ControllerCode, SlotIdentity } from "../src/pool/runtime-slots/contract.ts";
import { currentCrashCommand } from "../src/pool/runtime-crash-contract.ts";
import { decodeRuntimeHandoffCommand } from "../src/pool/runtime-slots/handoff-command.ts";
import { sendRuntimeCommand } from "./release-barrier/runtime-command-rpc.ts";
import { isSigningKey } from "../src/pool/token.ts";
import type { PoolOperationsTarget } from "./pool-operations.ts";

const Name = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,128}$/u));
const Packet = Schema.Struct({
  accountId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u)),
  worker: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)),
  controllerCode: ControllerCode,
  identity: SlotIdentity,
  nonce: Name,
  operator: Name,
});
export function crashOperatorOptions(args: string[]) {
  if (
    args.length !== 3 ||
    args[0] !== "--packet" ||
    !args[1] ||
    !["--apply", "--inspect"].includes(args[2]!)
  )
    throw new Error("Use --packet <private-reviewed-packet.json> <--apply|--inspect>");
  return { packet: args[1]!, apply: args[2] === "--apply" };
}

/** Repeating a submitted packet only inspects. A lost reply cannot authorize another signal. */
export async function runCrashOperator(
  options: { packet: string; apply: boolean },
  signingKey: string,
  io: { connect?: PoolOperationsTarget["connect"]; now?: () => number } = {},
) {
  if (!isSigningKey(signingKey)) throw new Error("Operator signing key required");
  const packet = Schema.decodeUnknownSync(Packet, { onExcessProperty: "error" })(
    JSON.parse(await readFile(options.packet, "utf8")),
  );
  const digest = createHash("sha256").update(JSON.stringify(packet)).digest("hex");
  const marker = `${options.packet}.submitted.json`;
  let apply = options.apply;
  if (apply) {
    try {
      await writeFile(marker, JSON.stringify({ digest, status: "submitted" }), {
        mode: 0o600,
        flag: "wx",
        flush: true,
      });
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const previous: unknown = JSON.parse(await readFile(marker, "utf8"));
      const decoded = Schema.decodeUnknownSync(
        Schema.Struct({ digest: Schema.String, status: Schema.Literal("submitted") }),
      )(previous);
      if (decoded.digest !== digest) throw new Error("Submitted crash packet changed");
      apply = false;
    }
  }
  const now = io.now ?? Date.now;
  const at = now();
  const common = {
    controllerCode: packet.controllerCode,
    identity: packet.identity,
    nonce: packet.nonce,
    at,
    expiresAt: at + 25_000,
  };
  const command = apply
    ? currentCrashCommand({ ...common, action: "runtime-crash", operator: packet.operator }, at)
    : decodeRuntimeHandoffCommand({ ...common, action: "runtime-crash-inspect" }, at);
  const result = await sendRuntimeCommand(
    command,
    signingKey,
    {
      accountId: packet.accountId,
      worker: packet.worker,
      connect: io.connect,
    },
    () => {
      if (apply) currentCrashCommand(command, now());
      else decodeRuntimeHandoffCommand(command, now());
    },
  );
  const receiptPath = `${options.packet}.receipt.json`;
  await writeFile(receiptPath, JSON.stringify({ digest, inspection: !apply, result }), {
    mode: 0o600,
    flush: true,
  });
  return { status: apply ? "submitted" : "inspection", receiptPath };
}

if (import.meta.main) {
  try {
    const result = await runCrashOperator(
      crashOperatorOptions(process.argv.slice(2)),
      process.env.POOL_DEPLOYMENT_KEY ?? "",
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(
      "Runtime crash outcome unavailable. Keep the packet and marker; repeat only to inspect.\n",
    );
    process.exitCode = 1;
  }
}
