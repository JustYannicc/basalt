import type { ComputerHome } from "./computer-home.ts";
import type { Registry, StoredComputer } from "./computer-registry.ts";
import { BackendFailure, ControlFailure } from "./json.ts";
import { homeFailure, revokedByPerson } from "./native-computers.ts";

/** How long upkeep waits before asking Home again about one row, or about any row after Home fails. */
export const leftoverRetryMs = 60_000;
/** A web setup takes seconds; an `issuing` row this old with no key and no link was interrupted. */
export const interruptedSetupMs = 60 * 60_000;
/** One pass's share of the pool's upkeep, as pending-pool provisioning has. */
const passBudgetMs = 2_000;

interface Dependencies {
  home: ComputerHome;
  /** The Home keys revoking this computer removes. */
  keys: (computer: StoredComputer) => Promise<readonly number[]>;
  now: () => number;
  run: <A>(work: (registry: Registry) => Promise<A>) => Promise<A>;
  save: (registry: Registry) => Promise<unknown>;
}
type Outcome = "revoked" | "awaitsPerson" | "interruptedRemoved";

/**
 * Rows a revoke or an interrupted web setup left behind, finished once Home answers. A revoke
 * stops at `revoking` when Home fails, and nothing else repeats it; a web setup interrupted before
 * its key was stored leaves an `issuing` row with no key and no link. Home is asked outside the
 * registry queue, so a stopped container holds up no device. The retry times live in memory, so
 * a restarted object may ask once more early.
 */
export class ComputerLeftovers {
  private deps: Dependencies;
  private revoking = new Map<string, Promise<void>>();
  private retryAt = new Map<string, number>();
  private homeRetryAt = 0;
  private undecidedReported: number | undefined;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  /** One Home revocation per computer at a time; a person's revoke and upkeep share it. */
  revokeKeys(computer: StoredComputer): Promise<void> {
    const running = this.revoking.get(computer.id);
    if (running) return running;
    const work = (async () => {
      for (const id of await this.deps.keys(computer)) await this.deps.home.revoke(id);
    })().finally(() => this.revoking.delete(computer.id));
    this.revoking.set(computer.id, work);
    return work;
  }
  /**
   * One upkeep pass, least recently tried rows first. A row is tried at most once a minute; after
   * Home fails to answer, no row is tried for a minute.
   */
  async finish(): Promise<void> {
    const start = this.deps.now();
    const rows = await this.deps.run(async (registry) => {
      // Needs no Home, so it runs whatever Home answered last.
      await this.finishLegacy(registry, start);
      if (start < this.homeRetryAt) return [];
      for (const id of this.retryAt.keys())
        if (!Object.hasOwn(registry, id) || !leftBehind(registry[id]!, start))
          this.retryAt.delete(id);
      const due = Object.values(registry)
        .filter(
          (computer) =>
            leftBehind(computer, start) && (this.retryAt.get(computer.id) ?? 0) <= start,
        )
        .sort((a, b) => (this.retryAt.get(a.id) ?? 0) - (this.retryAt.get(b.id) ?? 0))
        .map((computer) => structuredClone(computer));
      for (const computer of due) this.retryAt.set(computer.id, start + leftoverRetryMs);
      return due;
    });
    if (!rows.length) return;
    const counts: Record<Outcome, number> = { revoked: 0, awaitsPerson: 0, interruptedRemoved: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<"budget">((resolve) => {
      timer = setTimeout(() => resolve("budget"), passBudgetMs);
    });
    try {
      for (const row of rows) {
        // Counted from when it is tried, so a long pass can't shorten its wait.
        this.retryAt.set(row.id, this.deps.now() + leftoverRetryMs);
        try {
          if ((await Promise.race([this.revokeKeys(row), budget])) === "budget") break;
        } catch (error) {
          if (!unanswered(error)) continue;
          this.homeRetryAt = this.deps.now() + leftoverRetryMs;
          console.error("POOL_LEFTOVER_HOME_UNAVAILABLE", {
            pending: rows.length,
            failure: homeFailure(error),
          });
          break;
        }
        const outcome = await this.deps.run((registry) => this.settle(registry, row));
        if (outcome) counts[outcome]++;
      }
    } finally {
      clearTimeout(timer);
    }
    if (counts.revoked || counts.awaitsPerson || counts.interruptedRemoved)
      console.info("POOL_LEFTOVERS_FINISHED", counts);
  }
  /**
   * Tools-only rows an older release left that show their person revoked them (a `removed` row
   * with no recorded reason, or one under removal that began during a revoke) are finished
   * revoked, so membership can never bring them back. One count-only line reports them, and the
   * rows under removal that began from `active`, which can't be told apart from an access removal.
   */
  private async finishLegacy(registry: Registry, now: number) {
    let revoked = 0;
    let undecided = 0;
    for (const computer of Object.values(registry)) {
      if (computer.native?.models !== false || computer.restoredWithoutHistory) continue;
      const pending = computer.removalPending === true;
      if (!pending && computer.state !== "removed") continue;
      if (!revokedByPerson(computer)) {
        if (pending) undecided++;
        continue;
      }
      computer.state = "revoked";
      computer.revokedAt ??= new Date(now).toISOString();
      delete computer.removedAt;
      delete computer.removedFor;
      delete computer.removalPending;
      delete computer.removalAt;
      delete computer.beforeRemoval;
      revoked++;
    }
    if (revoked) await this.deps.save(registry);
    if (revoked || undecided !== this.undecidedReported) {
      if (revoked || undecided) console.info("POOL_LEGACY_TOOLS_ONLY_ROWS", { revoked, undecided });
      this.undecidedReported = undecided;
    }
  }
  /** Finish the row if nothing changed it while Home was asked. */
  private async settle(registry: Registry, row: StoredComputer): Promise<Outcome | undefined> {
    const computer = Object.hasOwn(registry, row.id) ? registry[row.id] : undefined;
    if (
      !computer ||
      computer.state !== row.state ||
      computer.keyId !== row.keyId ||
      !leftBehind(computer, this.deps.now())
    )
      return undefined;
    const at = new Date(this.deps.now()).toISOString();
    let outcome: Outcome;
    if (computer.state === "issuing") {
      delete registry[computer.id];
      outcome = "interruptedRemoved";
    } else if (computer.toolsKeyId !== undefined || (computer.native && !computer.native.models)) {
      // Its tools answer to a web setup's tools token or a native device's grant, which only the
      // person's own revoke ends. Until it has, the row stays `revoking`: it may still work.
      computer.homeKeysRevokedAt = at;
      outcome = "awaitsPerson";
    } else {
      computer.state = "revoked";
      computer.revokedAt ??= at;
      delete computer.link;
      if (computer.native) delete computer.native.key;
      outcome = "revoked";
    }
    this.retryAt.delete(row.id);
    await this.deps.save(registry);
    return outcome;
  }
}

function leftBehind(computer: StoredComputer, now: number) {
  if (computer.state === "revoking")
    return (
      !computer.removalPending &&
      !computer.restoredWithoutHistory &&
      computer.homeKeysRevokedAt === undefined
    );
  return (
    computer.state === "issuing" &&
    !computer.native &&
    computer.keyId === undefined &&
    !computer.link &&
    Date.parse(computer.createdAt) <= now - interruptedSetupMs
  );
}

/** Home didn't answer, or answered with its own failure: every row would fail the same way. */
function unanswered(error: unknown) {
  if (error instanceof BackendFailure) return error.backendStatus >= 500;
  return !(error instanceof ControlFailure) || error.status >= 500;
}
