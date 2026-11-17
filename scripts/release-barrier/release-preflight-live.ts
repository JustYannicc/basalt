import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { canonical } from "./manifest.ts";
import { ReleaseSettlementDisposition } from "./release-settlement-contract.ts";

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
 * Codes to try, in order: the recorded readiness code, then the codes a release receipt names
 * for the release the controller reports running, then this checkout's revision of it.
 */
export function liveControllerCodes(input: {
  recorded: Code;
  running: string | undefined;
  receipts: readonly Code[];
  workerInput: string;
}) {
  const codes: { source: string; code: Code }[] = [{ source: "recorded", code: input.recorded }];
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

export const supportedDispositions: readonly string[] = ReleaseSettlementDisposition.literals;

/**
 * Which settlement an unsettled prior candidate needs: once its controller runs, adopted or not by
 * whether a slot is selected; before that, abandoned. Supported means this candidate can settle it.
 */
export function settlementVerdict(input: {
  prior: string;
  liveCandidate: string;
  selected: boolean;
  supported?: readonly string[];
}) {
  const disposition =
    input.liveCandidate !== input.prior
      ? "abandoned-before-controller"
      : input.selected
        ? "controller-active-adopted"
        : "controller-active-unadopted";
  return {
    disposition,
    supported: (input.supported ?? supportedDispositions).includes(disposition),
  };
}
