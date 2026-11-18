import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { canonical } from "./manifest.ts";
import { ReleaseSettlementDisposition } from "./release-settlement-contract.ts";
import type { RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { fleetColors } from "./runtime-release-fleet.ts";

type Code = typeof ControllerCode.Type;
const Receipt = Schema.Struct(ControllerCode.fields);

/**
 * The controller codes earlier releases signed with, from their own provider-observation
 * receipts. A receipt is only a claim: the controller accepting a signed inspect proves it.
 */
export async function releaseReceiptCodes(directory: string | undefined): Promise<Code[]> {
  if (!directory) return [];
  const codes: Code[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory, { recursive: true });
  } catch {
    return [];
  }
  for (const entry of entries.filter((path) => path.endsWith("provider-observation.json")))
    try {
      codes.push(
        Schema.decodeUnknownSync(Receipt, { onExcessProperty: "ignore" })(
          JSON.parse(await readFile(join(directory, entry), "utf8")),
        ),
      );
    } catch {}
  return codes;
}

/**
 * Codes to try, in order: the release's own baseline choice when it is not the readiness row; the
 * recorded readiness code; the code the receipts name for the journal's unsettled prior candidate,
 * whose controller phase may be the one running; the code they name for the release the
 * controller reports running; then this checkout's revision of it.
 */
export function liveControllerCodes(input: {
  release?: { source: string; code: Code };
  recorded: Code | undefined;
  prior?: string;
  running: string | undefined;
  receipts: readonly Code[];
  workerInput: string;
}) {
  const codes: { source: string; code: Code }[] = [
    ...(input.release ? [input.release] : []),
    ...(input.recorded ? [{ source: "recorded", code: input.recorded }] : []),
  ];
  for (const code of input.receipts)
    if (input.prior && code.candidate === input.prior)
      codes.push({ source: "prior-release-receipt", code });
  if (input.running) {
    for (const code of input.receipts)
      if (code.candidate === input.running) codes.push({ source: "release-receipt", code });
    codes.push({
      source: "checkout-revision",
      code: { candidate: input.running, workerInput: input.workerInput },
    });
  }
  const seen = new Set<string>();
  return codes.filter(({ code }) => {
    const key = canonical(code);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What settlement needs from the unsettled prior's record: fleet applications in its baseline, and
 * nothing past them journaled, which fleet-attached-unstarted's own source guards also require.
 */
export const unsettledPrior = (
  record: Pick<
    RuntimeReleaseRecord,
    "candidate" | "baseline" | "promotion" | "update" | "abort" | "complete"
  >,
) => ({
  candidate: record.candidate,
  fleetAttached:
    fleetColors(record).length > 0 &&
    !record.promotion &&
    !record.update &&
    !record.abort &&
    !record.complete,
});

export const supportedDispositions: readonly string[] = ReleaseSettlementDisposition.literals;

/**
 * Which settlement an unsettled prior candidate needs: once its controller runs, adopted or not by
 * whether a slot is selected, and fleet-attached when its record's baseline holds fleet applications
 * and nothing past them is journaled; before that, abandoned. A selected fleet primary, with the
 * root retired, is a state no disposition proves yet (#1341), so it is named and never supported.
 * Supported means this candidate can settle it.
 */
export function settlementVerdict(input: {
  prior: string;
  liveCandidate: string;
  selected: boolean;
  /** `unsettledPrior(record).fleetAttached` for the prior record. */
  fleetAttached?: boolean;
  /** The selection's active slot is the legacy root (legacy-adoption-target.ts), not a primary. */
  rootSelected?: boolean;
  supported?: readonly string[];
}) {
  const disposition =
    input.liveCandidate !== input.prior
      ? "abandoned-before-controller"
      : !input.selected
        ? "controller-active-unadopted"
        : input.rootSelected === false
          ? "selected-fleet-primary"
          : input.fleetAttached
            ? "fleet-attached-unstarted"
            : "controller-active-adopted";
  return {
    disposition,
    supported: (input.supported ?? supportedDispositions).includes(disposition),
  };
}
