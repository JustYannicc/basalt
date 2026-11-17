import type { ForwardPacket } from "./forward-model.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import type { ReleaseSettlementDisposition } from "./release-settlement-contract.ts";

type Rows = readonly { worker: string; versionId: string }[];

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
  const untouchedImage: [string, boolean][] = [
    ["record.candidate", record.candidate === source],
    ["forward.candidate", head.candidate === source],
    ["forward.manifest.candidate", packet.manifest.candidate === source],
    ["record.complete", !record.complete],
    ["record.abort", !record.abort],
    ["record.update", !record.update],
    ["record.promotion", !record.promotion],
    ["record.bootstrap", !Object.keys(record.bootstrap).length],
    ["record.configurations", !Object.keys(record.configurations).length],
    ["forward.frozen.container", packet.frozen.containers[0]?.id === "PoolContainer"],
    ["forward.manifest.workers", packet.manifest.workers.length <= 32],
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
      : [
          ...untouchedImage,
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
  return guards.find(([, ok]) => !ok)?.[0];
}
