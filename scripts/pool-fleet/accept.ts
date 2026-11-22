import type { ModelAuth, PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { AcceptanceFailure } from "../pool-acceptance/types.ts";
import { refuse } from "./errors.ts";
import { shortHash, type ControllerView, type FleetView } from "./controller.ts";
import { OwnTraffic, turnBudgets } from "./own-traffic.ts";

/*
 * scripts/pool-acceptance.ts asserts one boot for the whole pool ("Pool boot changed during
 * acceptance requests"), and its restart mode passes on any boot change. With a fleet, each
 * response's X-Signalbox-Pool-Boot is the serving runtime's boot, so both would misread a healthy
 * fleet. This gate reuses the same client and checks the fleet's own invariant instead.
 */

export interface AcceptanceInput {
  client: PoolAcceptanceClient;
  /** Signs each model call for the release's acceptance device. */
  credential: ModelAuth;
  model?: string;
  controller: () => Promise<ControllerView>;
  fleet: () => Promise<FleetView>;
  sleep: (ms: number) => Promise<void>;
  burst?: number;
  rounds?: number;
  log: (line: string) => void;
}

function selectModel(ids: string[], requested?: string) {
  if (requested) {
    if (!ids.includes(requested))
      throw new AcceptanceFailure("The requested model is not present in /v1/models");
    return requested;
  }
  if (ids.length !== 1)
    throw new AcceptanceFailure(`/v1/models returned ${ids.length} models; set the model input`);
  return ids[0]!;
}

export const primaryBoot = (view: ControllerView) => {
  const boot = view.selection?.active.identity?.bootId;
  if (!boot)
    throw refuse(
      "selection-missing",
      "Controller inspect shows no selected primary identity (selection.active.identity).",
      "Adopt the root first; the fleet is configured only beside a selected primary.",
    );
  return boot;
};

/** Boots of fleet cells, never the primary's; a draining cell that just served still counts. */
export const cellBoots = (fleet: FleetView, primary: string) =>
  new Set(
    fleet.resources
      .flatMap((row) => (row.identity ? [row.identity.bootId] : []))
      .filter((boot) => boot !== primary),
  );

/** The runtimes the controller reports serving: the selected primary and the fleet's cells. */
export async function servingBoots(input: Pick<AcceptanceInput, "controller" | "fleet">) {
  const primary = primaryBoot(await input.controller());
  return { primary, cells: cellBoots(await input.fleet(), primary) };
}

/**
 * Usage isolation is proven by the lane's own requests on the device's existing pool: each of its
 * turns is read back with the same device assertion, never with a pool owner token.
 */
export async function runFleetAcceptance(input: AcceptanceInput) {
  const { client, credential, log } = input;
  const traffic = new OwnTraffic(client, credential, turnBudgets.accept);
  const catalog = await traffic.catalog();
  const model = selectModel(catalog.ids, input.model);
  log(`models status=200 count=${catalog.ids.length}`);
  const burst = input.burst ?? 6;
  const known = new Set<string>();
  const observe = async () => {
    const serving = await servingBoots(input);
    for (const boot of [serving.primary, ...serving.cells]) known.add(boot);
    return serving;
  };
  let served: { round: number; cell: number; primary: number; other: number } | undefined;
  for (let round = 1; round <= (input.rounds ?? 3) && !served; round++) {
    // Ready cells take every turn; the root serves only while no cell is ready.
    const results = await Promise.all(Array.from({ length: burst }, () => traffic.turn(model)));
    const { primary, cells } = await observe();
    const count = { round, cell: 0, primary: 0, other: 0 };
    for (const result of results)
      if (cells.has(result.boot)) count.cell++;
      else if (result.boot === primary) count.primary++;
      else count.other++;
    log(
      `burst round=${round} turns=${burst} cell=${count.cell} primary=${count.primary} unknown_boot=${count.other}`,
    );
    if (count.cell > 0) served = count;
  }
  if (!served)
    throw refuse(
      "cell-served-proof-missing",
      `No streamed turn in ${input.rounds ?? 3} bursts of ${burst} carried a fleet cell's X-Signalbox-Pool-Boot; every response came from the primary or an unknown runtime.`,
      "Check fleet-inspect for a ready cell; if one is ready and still unused, the balancer never routed to it.",
    );
  const final = await traffic.turn(model);
  await observe();
  log(`final_request status=200 first_byte_ms=${Math.round(final.firstByteMs)}`);
  // Checked against every read, so a cell first reported after it served is still known.
  traffic.requireKnownBoots(known);
  const usage = await traffic.verifyUsage(input.sleep);
  log(
    `usage_records status=200 sessions=${usage.sessions} matched=${usage.records} accounts=${usage.accounts}`,
  );
  return { model, servedByCell: served, usageRecords: usage.records };
}

/**
 * crash-cell's own traffic: every response came from the primary or a cell reported before or
 * after the kill, and every turn's usage stayed in the device's pool.
 */
export async function crashTrafficAccepted(
  input: Pick<AcceptanceInput, "controller" | "fleet" | "sleep"> & {
    traffic: OwnTraffic;
    before: FleetView;
  },
) {
  const { primary, cells } = await servingBoots(input);
  input.traffic.requireKnownBoots(
    new Set([primary, ...cells, ...cellBoots(input.before, primary)]),
  );
  return input.traffic.verifyUsage(input.sleep);
}

/** After a disable: one plain streamed turn must come back from the selected primary. */
export async function rootServes(input: Omit<AcceptanceInput, "fleet" | "sleep">) {
  const traffic = new OwnTraffic(input.client, input.credential, turnBudgets.rootServes);
  const catalog = await traffic.catalog();
  const model = selectModel(catalog.ids, input.model);
  const result = await traffic.turn(model);
  const primary = primaryBoot(await input.controller());
  if (result.boot !== primary)
    throw refuse(
      "root-not-serving",
      `After fleet-disable a streamed turn came from boot ${shortHash(result.boot)}, not the primary's ${shortHash(primary)}.`,
      "Read fleet-inspect: a cell still serving after disable means the disable did not take effect.",
    );
  input.log(`root_request status=200 boot=primary`);
  return { boot: shortHash(primary) };
}
