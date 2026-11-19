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
  // The image record is the source's own and never reached bootstrap, update, promotion or abort.
  const untouchedRecord: [string, boolean][] = [
    ["record.candidate", record.candidate === source],
    ["record.complete", !record.complete],
    ["record.abort", !record.abort],
    ["record.update", !record.update],
    ["record.promotion", !record.promotion],
    ["record.bootstrap", !Object.keys(record.bootstrap).length],
    ["record.configurations", !Object.keys(record.configurations).length],
  ];
  const forwardOf = (owner: string | undefined): [string, boolean][] => [
    ["forward.candidate", head.candidate === owner],
    ["forward.manifest.candidate", packet.manifest.candidate === owner],
    ["forward.frozen.container", packet.frozen.containers[0]?.id === "PoolContainer"],
    ["forward.manifest.workers", packet.manifest.workers.length <= 32],
  ];
  const untouchedImage = [...untouchedRecord, ...forwardOf(source)];
  // The image journal froze the controller that ran before this candidate activated its own.
  const frozenController: [string, boolean] = [
    "record.baselineController",
    record.baselineController !== undefined && record.baselineController.code.candidate !== source,
  ];
  const completeReceipt: [string, boolean][] = [
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
      : disposition === "abandoned-before-forward"
        ? // The source never froze a manifest, so the forward head is still the complete packet of
          // the controller its image record froze, and no packet or receipt of the source exists.
          [
            ...untouchedRecord,
            frozenController,
            ...forwardOf(record.baselineController?.code.candidate),
            ...completeReceipt,
          ]
        : [...untouchedImage, frozenController, ...completeReceipt];
  return guards.find(([, ok]) => !ok)?.[0];
}
