import { nativeUsageMaxSessions, type NativeUsage } from "../../src/pool/native-usage-contract.ts";
import type { ModelAuth, PoolAcceptanceClient } from "../pool-acceptance/client.ts";
import { HttpStatusFailure, UserCapReached } from "../pool-acceptance/types.ts";
import { FleetLaneRefused, refuse } from "./errors.ts";

/** About the 45 s the owner-token read waited for a turn's rows to land. */
const usageReads = 45;

/**
 * The most streamed turns one run may send. They spend real accounts on production's pool, so each
 * mode's budget is fixed here rather than left to its loop's defaults.
 */
export const turnBudgets = { accept: 19, crashCell: 60, rootServes: 1 } as const;

/** The pool calls the lane makes; narrower than the client so a run's traffic is all here. */
type TrafficClient = Pick<PoolAcceptanceClient, "modelCatalog" | "sendTurn" | "nativeUsage">;

/** The device's user is at its cap: nothing more can be tested, and no further turn is sent. */
export const capReached = () =>
  refuse(
    "could-not-test-cap",
    "The pool refused a turn with its user-cap 429: the acceptance device's user is at its cap, so the lane sent no further turn and tested nothing more.",
    "Wait for the cap to reset or raise it for the acceptance device's user, then rerun.",
  );

export const isCapReached = (error: unknown) =>
  error instanceof FleetLaneRefused && error.reason === "could-not-test-cap";

/** One of the lane's own turns; `served` means it streamed to its end. */
interface OwnSession {
  readonly id: string;
  readonly served: boolean;
}

const fixRouting =
  "Read the PoolWorker routing for the acceptance device's key: its turns must be served only by its own pool's accounts.";

/**
 * Holds one read of the lane's own sessions to the isolation rule, failing at once on a violation,
 * since waiting cannot undo it. Returns how many served turns still wait for their success row.
 */
function checkUsage(sessions: readonly OwnSession[], answers: readonly NativeUsage[]) {
  const key = answers[0]?.key;
  const bySession = new Map(
    answers.flatMap((answer) => answer.sessions.map((row) => [row.session, row])),
  );
  const records = [...bySession.values()].flatMap((row) => row.records);
  // The route already fails closed on another key's row (usage-read-refused); this holds if the
  // route ever changes.
  if (answers.some((answer) => answer.key !== key) || records.some((row) => row.key !== key))
    throw refuse(
      "usage-other-key",
      "A usage row of the lane's own sessions was charged to a key other than the acceptance device's.",
      fixRouting,
    );
  const outside = records.filter((row) => !row.inPool).length;
  if (outside)
    throw refuse(
      "usage-outside-pool",
      `${outside} usage rows of the lane's own sessions were served by an account outside the acceptance device's pool, or by none.`,
      fixRouting,
    );
  let waiting = 0;
  for (const { id, served } of sessions) {
    const row = bySession.get(id);
    if (!row || !row.complete)
      throw refuse(
        "usage-incomplete",
        `The device usage read ${row ? "truncated" : "omitted"} one of the lane's own sessions.`,
        "Read the session's rows in Home; one turn leaves at most a few attempts.",
      );
    const successes = row.records.filter((record) => record.status === "success").length;
    if (successes > 1)
      throw refuse(
        "usage-duplicate",
        `One of the lane's own turns has ${successes} success rows; a turn is charged once.`,
        "Read the session's rows in Home for a retried or double-recorded request.",
      );
    if (served && successes === 0) waiting++;
  }
  return {
    waiting,
    summary: {
      sessions: sessions.length,
      records: records.length,
      accounts: new Set(records.map((row) => row.account)).size,
    },
  };
}

/**
 * Everything the lane sent as the acceptance device: each response's boot and each turn's session.
 * Isolation is proven by these requests alone, read back with the device's own assertion.
 */
export class OwnTraffic {
  readonly boots: string[] = [];
  private readonly sessions: OwnSession[] = [];
  private readonly client: TrafficClient;
  private readonly credential: ModelAuth;
  private readonly turns: number;
  /** Set by the first cap-coded 429; from then on this run sends no turn. */
  capped = false;
  constructor(client: TrafficClient, credential: ModelAuth, turns: number) {
    this.client = client;
    this.credential = credential;
    this.turns = turns;
  }
  get turnsLeft() {
    return this.capped ? 0 : Math.max(0, this.turns - this.sessions.length);
  }
  async catalog() {
    const catalog = await this.client.modelCatalog(this.credential);
    this.boots.push(catalog.boot);
    return catalog;
  }
  async turn(model: string) {
    if (this.capped) throw capReached();
    if (this.sessions.length >= this.turns)
      throw refuse(
        "turn-budget",
        `This run already sent its ${this.turns} turns, the most its mode may send.`,
        "Each turn spends a real account; change the mode's budget in turnBudgets only on purpose.",
      );
    const id = crypto.randomUUID().toLowerCase();
    try {
      const result = await this.client.sendTurn(this.credential, model, { id, expectedRecords: 1 });
      this.boots.push(result.boot);
      this.sessions.push({ id, served: true });
      return result;
    } catch (error) {
      // A cut turn can still leave rows, and those must stay in the pool too.
      this.sessions.push({ id, served: false });
      if (error instanceof UserCapReached) {
        this.capped = true;
        throw capReached();
      }
      throw error;
    }
  }

  /** Every response came from the selected primary or a fleet cell the controller reported. */
  requireKnownBoots(known: ReadonlySet<string>) {
    const unknown = this.boots.filter((boot) => !known.has(boot)).length;
    if (unknown)
      throw refuse(
        "unknown-boot",
        `${unknown} of ${this.boots.length} responses carried an X-Signalbox-Pool-Boot that is neither the selected primary's nor a fleet cell's.`,
        "Read fleet-inspect and the PoolWorker logs: a runtime outside the controller's fleet served the acceptance device.",
      );
  }

  /**
   * Waits for each served turn's success row. Every read holds every own session to the rule: one
   * success row per served turn and at most one per cut turn, every row charged to the device's own
   * key and served by an account in its pool.
   */
  async verifyUsage(sleep: (ms: number) => Promise<void>) {
    for (let attempt = 1; ; attempt++) {
      const answers = [];
      // One request at a time keeps Home at one request's bounded lookups.
      for (let at = 0; at < this.sessions.length; at += nativeUsageMaxSessions) {
        const ids = this.sessions.slice(at, at + nativeUsageMaxSessions).map(({ id }) => id);
        answers.push(await this.read(ids));
      }
      const { waiting, summary } = checkUsage(this.sessions, answers);
      if (!waiting) return summary;
      if (attempt >= usageReads)
        throw refuse(
          "usage-missing",
          `${waiting} of ${this.sessions.filter(({ served }) => served).length} served turns still had no success row charged to the acceptance device's key after ${usageReads} reads.`,
          "Read those sessions' rows in Home across every key: the device reads only its own key's rows, so a turn Home never recorded and one charged to another key look the same here.",
        );
      await sleep(1_000);
    }
  }

  private async read(ids: readonly string[]) {
    try {
      return await this.client.nativeUsage(this.credential, ids);
    } catch (error) {
      // The route fails the whole read closed when Home returns a row of another session or key, so
      // another key's row shows only as this.
      if (error instanceof HttpStatusFailure && error.status === 503)
        throw refuse(
          "usage-read-refused",
          "The device usage read answered 503: Home returned a row of another session or key, or Home was unavailable.",
          "Read the lane's sessions in Home across every key; a row on another key means routing charged a key other than the acceptance device's.",
        );
      throw error;
    }
  }
}
