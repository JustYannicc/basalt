import type { ModelAuth, PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { AcceptanceFailure, type PoolAccess } from "../pool-acceptance/types.ts";
import { refuse } from "./errors.ts";
import { shortHash, type ControllerView, type FleetView } from "./controller.ts";
import { OwnTraffic, turnBudgetSpent, turnBudgets } from "./own-traffic.ts";
import { quotaRefusal, smokeModels, turnFailure } from "../release/smoke-models.ts";

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
  /**
   * An owner token for a dedicated acceptance pool only. Absent when the device is in a pool that
   * holds people's work: then the two reads it allows (the pool's accounts, its usage) are skipped.
   */
  access?: PoolAccess;
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
 * Every acceptance model the pool lists was refused for funding: Home's decision from the pool's
 * accounts in the shared database, which a cell answers as the root would, so nothing proved or
 * disproved a cell.
 */
export const quotaRefused = "acceptance-quota-refused";
/**
 * Every model was refused for quota, at least once as `model_cooldown`: a node cools a model after
 * its provider refuses every credential, which a broken cell does on its own
 * (scripts/release/smoke-models.ts), so this counts as a cell that fails to serve.
 */
export const cooldownRefused = "acceptance-cooldown-refused";

/**
 * A burst's turns, all settled: a failure stands for the burst, and one that is not the pool's
 * quota refusal goes first, so a quota refusal never hides another turn's failure.
 */
async function settledBurst<A>(turns: readonly Promise<A>[]) {
  const results = await Promise.allSettled(turns);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  const failure = failures.find((reason) => !quotaRefusal(reason)) ?? failures[0];
  if (failures.length) throw failure;
  return results.map((result) => (result as PromiseFulfilledResult<A>).value);
}

/**
 * The deploy smoke's order: the configured model, then the other acceptance models the pool lists.
 * A model the pool refuses for quota moves to the next; any other failure is the answer. Usage
 * isolation is proven by the lane's own requests on the device's existing pool: each of its turns
 * is read back with the same device assertion, and only a dedicated acceptance pool's owner token
 * adds the pool-wide check on top. One turn budget covers every model the run tries.
 */
export async function runFleetAcceptance(input: AcceptanceInput) {
  const traffic = new OwnTraffic(input.client, input.credential, turnBudgets.accept);
  const catalog = await traffic.catalog();
  const first = selectModel(catalog.ids, input.model);
  const accounts = input.access ? await input.client.testAccountIds(input.access) : undefined;
  input.log(`models status=200 count=${catalog.ids.length}`);
  const tried: string[] = [];
  let cooled = false;
  // The model the turn budget ran out on, when refused models had spent it first.
  let spentOn: string | undefined;
  for (const model of smokeModels(first).filter((id) => catalog.ids.includes(id)))
    try {
      const accepted = await acceptOn(input, model, accounts, traffic);
      return tried.length ? { ...accepted, quotaRefused: tried } : accepted;
    } catch (error) {
      const quota = quotaRefusal(error);
      // The budget bounds what a run sends, however many models it tries. Spent by turns the pool
      // refused for quota, the run ends as that refusal, never as a failed acceptance, which would
      // stop a release for the wrong reason.
      if (!quota && tried.length && turnBudgetSpent(error)) {
        spentOn = model;
        break;
      }
      if (!quota) throw error;
      if (quota === "model_cooldown") cooled = true;
      tried.push(`${model}: ${turnFailure(error)}`);
      input.log(`model=${model} refused for quota; trying the next acceptance model`);
    }
  // Every model refused, or the budget spent by those refused before another could prove a cell.
  const refused = spentOn
    ? `The run's turn budget ran out on ${spentOn} after the pool refused ${tried.join("; ")} for quota`
    : `Every acceptance model the pool lists was refused for ${cooled ? "quota" : "funding"} (${tried.join("; ")})`;
  throw cooled
    ? refuse(
        cooldownRefused,
        `${refused}, at least one as model_cooldown. A node cools a model after its provider refuses every credential, so the cell may be what fails.`,
        "Read the cell's log for the provider refusals; once a model has quota on the root, run the fleet lane's configure-and-accept with a new GO.",
      )
    : refuse(
        quotaRefused,
        `${refused}, so no turn proved a cell serves.`,
        "Wait for the acceptance pool's funding, then run the fleet lane's accept mode. The permission stays as configured.",
      );
}

async function acceptOn(
  input: AcceptanceInput,
  model: string,
  accounts: Set<string> | undefined,
  traffic: OwnTraffic,
) {
  const { client, log, access } = input;
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
    const results = await settledBurst(Array.from({ length: burst }, () => traffic.turn(model)));
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
  let ownerUsageRecords: number | "skipped" = "skipped";
  if (access && accounts) {
    // With an owner token, the pool-wide check stays mandatory: every record in the test pool's accounts.
    const records = await Promise.all(
      traffic.servedSessions.map((id) =>
        client.waitForUsageRecords(access, { id, expectedRecords: 1 }),
      ),
    );
    if (records.flat().some((record) => !accounts.has(record.account)))
      throw new AcceptanceFailure("Usage contained an account outside the dedicated test pool");
    ownerUsageRecords = records.flat().length;
    log(`owner_usage_records status=200 matched=${ownerUsageRecords}`);
  } else
    log("owner_usage_records skipped; the acceptance device is not in a dedicated acceptance pool");
  return { model, servedByCell: served, usageRecords: usage.records, ownerUsageRecords };
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
export async function rootServes(input: Omit<AcceptanceInput, "fleet" | "sleep" | "access">) {
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
