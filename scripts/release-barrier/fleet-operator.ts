import { readFile, writeFile } from "node:fs/promises";
import { Schema } from "effect";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import {
  RuntimeFleetOperation,
  runtimeFleetOperationDigest,
  runtimeFleetRequest,
  validateRuntimeFleetRequest,
  inspectRuntimeFleetOperation,
} from "./runtime-fleet-operation.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

const Packet = Schema.Struct({
  operation: RuntimeFleetOperation,
  enable: Schema.optional(
    Schema.Struct({
      coordinatorGo: Schema.NonEmptyString,
      manifest: Schema.String,
      writerLease: Schema.NonEmptyString,
      expiresAt: Schema.Int,
    }),
  ),
});
const Marker = Schema.Struct({
  format: Schema.Literal("pool-fleet-operator-submission-v1"),
  manifest: Schema.String,
  disposition: Schema.Literals(["submitted", "acknowledged"]),
});
function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
export function fleetOperatorOptions(args: string[]) {
  if (
    args.length !== 3 ||
    args[0] !== "--packet" ||
    !args[1] ||
    !["--apply", "--inspect"].includes(args[2]!)
  )
    throw new Error("Use --packet <private-reviewed-packet.json> <--apply|--inspect>");
  return { packet: args[1]!, apply: args[2] === "--apply" };
}

/** A durable local submission marker makes every repeat inspection-only, even after the writer GO expires. */
export async function runFleetOperator(
  options: { packet: string; apply: boolean },
  signingKey: string,
  io: { connect?: PoolOperationsTarget["connect"]; now?: () => number } = {},
) {
  const packet = Schema.decodeUnknownSync(Packet, { onExcessProperty: "error" })(
    JSON.parse(await readFile(options.packet, "utf8")),
  );
  const manifest = runtimeFleetOperationDigest(packet.operation);
  const target: PoolOperationsTarget = {
    accountId: packet.operation.controller.accountId,
    worker: packet.operation.controller.scriptName,
    connect: io.connect,
  };
  const markerPath = `${options.packet}.submitted.json`,
    receiptPath = `${options.packet}.receipt.json`;
  let previous: unknown;
  try {
    previous = JSON.parse(await readFile(markerPath, "utf8"));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  if (previous !== undefined) {
    const marker = Schema.decodeUnknownSync(Marker, { onExcessProperty: "error" })(previous);
    sameProvisioningValue("fleet.operator.submission", manifest, marker.manifest);
  }
  let apply = options.apply && previous === undefined;
  if (apply) {
    validateRuntimeFleetRequest(packet.operation, packet.enable, signingKey, target, io.now);
    try {
      await writeFile(
        markerPath,
        JSON.stringify({
          format: "pool-fleet-operator-submission-v1",
          manifest,
          disposition: "submitted",
        }),
        { mode: 0o600, flag: "wx", flush: true },
      );
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      const marker = Schema.decodeUnknownSync(Marker, { onExcessProperty: "error" })(
        JSON.parse(await readFile(markerPath, "utf8")),
      );
      sameProvisioningValue("fleet.operator.submission", manifest, marker.manifest);
      apply = false;
    }
  }
  const result = apply
    ? await runtimeFleetRequest(packet.operation, packet.enable, signingKey, target, io.now)
    : await inspectRuntimeFleetOperation(packet.operation, signingKey, target, io.now);
  const receipt = {
    format: "pool-fleet-operator-receipt-v1",
    manifest,
    disposition: apply ? "acknowledged" : "inspection",
    result,
  };
  await writeFile(receiptPath, JSON.stringify(receipt), { mode: 0o600, flush: true });
  if (apply)
    await writeFile(
      markerPath,
      JSON.stringify({
        format: "pool-fleet-operator-submission-v1",
        manifest,
        disposition: "acknowledged",
      }),
      { mode: 0o600, flush: true },
    );
  return { status: receipt.disposition, manifest, receiptPath };
}

if (import.meta.main) {
  try {
    const result = await runFleetOperator(
      fleetOperatorOptions(process.argv.slice(2)),
      process.env.POOL_DEPLOYMENT_KEY ?? "",
    );
    process.stdout.write(
      `${JSON.stringify({ status: result.status, manifest: result.manifest })}\n`,
    );
  } catch {
    process.stderr.write(
      "Fleet operation unavailable. Keep the private packet and submission marker; repeat only to inspect.\n",
    );
    process.exitCode = 1;
  }
}
