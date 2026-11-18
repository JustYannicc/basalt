import { Schema } from "effect";
import { fleetClassName } from "../../src/pool/fleet-deployment.ts";
import { RuntimeColorSchema } from "../../src/pool/image-release-plan.ts";
import type { ForwardPacket } from "./forward-model.ts";
import { fleetColors } from "./runtime-release-fleet.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import type { ReleaseSettlementDisposition } from "./release-settlement-contract.ts";

type Rows = readonly { worker: string; versionId: string }[];
const isColor = Schema.is(RuntimeColorSchema);

/**
 * Each bootstrap the source journaled finished: its manifest (already decoded by the journal) is the
 * source's own for that colour, and the native row it created, under the manifest's own instance,
 * is in the record's baseline. The record may hold none: a release that adopted applications an
 * earlier candidate created bootstraps nothing.
 */
function bootstrapSettled(source: string, record: RuntimeReleaseRecord) {
  return Object.entries(record.bootstrap).every(([color, manifest]) => {
    if (!isColor(color)) return false;
    const native = record.baseline.applications[color];
    return (
      manifest.candidate === source &&
      manifest.operationId === `bootstrap-${color}-${source}` &&
      manifest.declaration.fqn === fleetClassName(color) &&
      native?.resource === fleetClassName(color) &&
      native.instanceId === manifest.declaration.instanceId
    );
  });
}

/**
 * A configuration the source retained names only the baseline's fleet applications. That it names
 * the live controller is checked against the proven code in release-settlement-proof.ts.
 */
const configurationsOwned = (record: RuntimeReleaseRecord) =>
  Object.values(record.configurations).every((configuration) =>
    configuration.applications.every(
      (app) =>
        record.baseline.applications[app.color]?.attributes.applicationId === app.applicationId,
    ),
  );

/** Names the first journaled source guard a disposition fails, or undefined when it may archive. */
export function settlementSourceFailure(
  disposition: ReleaseSettlementDisposition,
  source: string,
  record: RuntimeReleaseRecord,
  head: { candidate: string },
  packet: ForwardPacket,
) {
  const { receipt } = packet;
  const workers = packet.manifest.workers.map((worker) => worker.id);
  const eachOnce = (rows: Rows) =>
    rows.length === workers.length &&
    workers.every((id) => rows.filter((row) => row.worker === id).length === 1);
  const sourceRecord: [string, boolean][] = [
    ["record.candidate", record.candidate === source],
    ["forward.candidate", head.candidate === source],
    ["forward.manifest.candidate", packet.manifest.candidate === source],
    ["record.complete", !record.complete],
    ["record.abort", !record.abort],
    ["record.update", !record.update],
    ["record.promotion", !record.promotion],
  ];
  const frozen: [string, boolean][] = [
    ["forward.frozen.container", packet.frozen.containers[0]?.id === "PoolContainer"],
    ["forward.manifest.workers", packet.manifest.workers.length <= 32],
  ];
  const untouchedImage: [string, boolean][] = [
    ...sourceRecord,
    ["record.bootstrap", !Object.keys(record.bootstrap).length],
    ["record.configurations", !Object.keys(record.configurations).length],
    ...frozen,
  ];
  // Fleet applications are attached only after adopt, so the source's controller phase finished.
  const fleetImage: [string, boolean][] = [
    ...sourceRecord,
    ["record.baseline.fleet", fleetColors(record).length > 0],
    ["record.bootstrap", bootstrapSettled(source, record)],
    ["record.configurations", configurationsOwned(record)],
    ...frozen,
  ];
  const activated: [string, boolean][] = [
    // The image journal froze the controller that ran before this candidate activated its own.
    [
      "record.baselineController",
      record.baselineController !== undefined &&
        record.baselineController.code.candidate !== source,
    ],
    ["receipt.phase", receipt.phase === "complete"],
    ["receipt.pending", !receipt.pending],
    ["receipt.pendingUpload", !receipt.pendingUpload],
    ["receipt.pendingContainer", !receipt.pendingContainer],
    ["receipt.accepted", eachOnce(receipt.accepted)],
    [
      "receipt.activated",
      eachOnce(receipt.activated) &&
        receipt.activated.every(
          (row) =>
            receipt.accepted.find((accepted) => accepted.worker === row.worker)?.versionId ===
            row.versionId,
        ),
    ],
    [
      "receipt.containers",
      (receipt.containers ?? []).every(
        (row) => row.container === "PoolContainer" && row.unchanged === true,
      ),
    ],
  ];
  const guards: [string, boolean][] =
    disposition === "abandoned-before-controller"
      ? [
          ...untouchedImage,
          ["receipt.phase", receipt.phase === "upload"],
          ["receipt.activated", !receipt.activated.length],
          ["receipt.pending", !receipt.pending],
          ["receipt.pendingContainer", !receipt.pendingContainer],
          ["receipt.containers", !receipt.containers?.length],
        ]
      : disposition === "fleet-attached-unstarted"
        ? [...fleetImage, ...activated]
        : [...untouchedImage, ...activated];
  return guards.find(([, ok]) => !ok)?.[0];
}
