import { Schema } from "effect";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";

/** What the controller's signed read-only inspect and fleet-inspect say now. */
export interface ControllerRead {
  readonly root: string;
  /** Boots of fleet cells, never the root's; a draining cell that just served still counts. */
  readonly cells: ReadonlySet<string>;
  readonly fleetEnabled: boolean;
}

/**
 * The root's boot and the fleet cells' boots, read from the controller. A served answer names
 * whichever runtime served it, and once cells serve that is rarely the root, so a release judges
 * the root by this read only.
 */
export interface RootReads {
  /** Throws when the controller can't be read or names no selected root. */
  read(): Promise<ControllerRead>;
}

/** The `--serving-controller` packet: the crash operator's `{"controllerCode": ...}` shape. */
export const servingControllerCode = (packet: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ controllerCode: ControllerCode }))(JSON.parse(packet))
    .controllerCode;

/** Why a read of the controller failed, without its message: messages can name hosts. */
export const unreadable = (error: unknown) =>
  `the controller's signed inspect could not be read (${
    error instanceof Error ? ((error as { reason?: string }).reason ?? error.name) : "unknown"
  }), so the root's boot is unknown`;

/**
 * Without the serving controller's code, the boot read before the apply is the served one. It is
 * the root's when the controller names that boot now: boots never repeat. A different boot means
 * the root restarted only while the root serves alone; with an enabled fleet or any cell it may have
 * been a cell's, and the run stops rather than guess. A pool that didn't answer recorded no boot at
 * all, and a wait against none takes the stuck root for a new one, so that stops too.
 */
export const servedBootStandsIn = (now: ControllerRead, served: string | undefined) =>
  served === undefined
    ? "the pool did not answer before the apply, so nothing recorded the root's boot; pass --serving-controller so it is read from the controller"
    : served === now.root || (!now.fleetEnabled && now.cells.size === 0)
      ? undefined
      : "the boot read before the apply was a served one and may be a fleet cell's; pass --serving-controller so it is read from the controller";

/**
 * Reads again until `withinMs`. After an upload the controller object keeps the previous code for a
 * while (`controllerAdoptionMs`) and refuses a command signed for this checkout's code until it
 * adopts it; an answer then also proves the new code runs. Each try opens a bridge connection, so
 * tries are 30 s apart.
 */
export function retryingReads(
  source: RootReads,
  withinMs: number,
  clock: { now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {},
): RootReads {
  const now = clock.now ?? Date.now;
  const sleep =
    clock.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  return {
    read: async () => {
      const started = now();
      for (;;) {
        try {
          return await source.read();
        } catch (error) {
          if (now() - started >= withinMs) throw error;
        }
        await sleep(30_000);
      }
    },
  };
}

/** Signed reads of the PoolWorker this stage runs, for the given controller code. */
export async function controllerRootReads(options: {
  readonly code: ControllerCode;
  readonly stage: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<RootReads> {
  const [{ Effect }, cloudflare, controller, fleet] = await Promise.all([
    import("effect"),
    import("../pool-fleet/cloudflare.ts"),
    import("../pool-fleet/controller.ts"),
    import("../pool-fleet/accept.ts"),
  ]);
  const { CLOUDFLARE_ACCOUNT_ID: accountId = "", CLOUDFLARE_API_TOKEN: apiToken = "" } =
    options.env;
  // Resolved at the first read: a run whose model calls already failed never needs the controller.
  let worker: Promise<string> | undefined;
  return {
    read: async () => {
      worker ??= Effect.runPromise(
        cloudflare.poolWorkerName(
          { accountId, apiToken, fetch: globalThis.fetch },
          "basalt",
          options.stage,
        ),
      );
      const resolved = await worker.catch((error: unknown) => {
        worker = undefined;
        throw error;
      });
      const access = {
        accountId,
        worker: resolved,
        // The pool Worker opens handoff envelopes with its deployment key, as the crash dispatcher
        // signs them.
        signingKey: options.env.POOL_DEPLOYMENT_KEY ?? "",
        code: options.code,
        // Reads write no operator packet.
        directory: "",
      };
      const root = fleet.primaryBoot(await controller.inspectController(access));
      const view = await controller.inspectFleet(access);
      return {
        root,
        cells: fleet.cellBoots(view, root),
        fleetEnabled: view.permission?.enabled === true,
      };
    },
  };
}
