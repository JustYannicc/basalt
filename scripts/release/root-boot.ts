import { Schema } from "effect";
import { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";

/**
 * The root's boot and the fleet cells' boots, from the controller's signed read-only inspect. A
 * served answer names whichever runtime served it, and once cells serve that is rarely the root,
 * so a release judges the root by these reads only.
 */
export interface RootReads {
  /** Throws when the controller can't be read or names no selected root. */
  root(): Promise<string>;
  /** Boots of fleet cells, never the root's. */
  cells(root: string): Promise<ReadonlySet<string>>;
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
 * Without the serving controller's code nothing reads the root's boot before the apply, so the
 * served boot stands in for it. That holds only while the root serves alone: any fleet cell with
 * an identity could have answered instead, and the run then stops rather than guess.
 */
export async function servedBootStandsIn(reads: RootReads) {
  let cells: ReadonlySet<string>;
  try {
    cells = await reads.cells(await reads.root());
  } catch (error) {
    return unreadable(error);
  }
  return cells.size
    ? `${cells.size} fleet cell(s) can serve, so the boot read before the apply may be a cell's; pass --serving-controller to read the root's boot from the controller`
    : undefined;
}

/**
 * Reads that answer from any of the given codes, again until `withinMs`. After an upload the
 * controller object keeps the previous code for a while (`controllerAdoptionMs`) and refuses a
 * command signed for the other one; either answer names the same root.
 */
export function retryingReads(
  sources: readonly RootReads[],
  withinMs: number,
  clock: { now?: () => number; sleep?: (milliseconds: number) => Promise<void> } = {},
): RootReads {
  const now = clock.now ?? Date.now;
  const sleep =
    clock.sleep ??
    ((milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds)));
  const attempt = async <A>(read: (source: RootReads) => Promise<A>) => {
    const started = now();
    for (;;) {
      let last: unknown;
      for (const source of sources) {
        try {
          return await read(source);
        } catch (error) {
          last = error;
        }
      }
      if (now() - started >= withinMs) throw last;
      await sleep(5_000);
    }
  };
  return {
    root: () => attempt((source) => source.root()),
    cells: (root) => attempt((source) => source.cells(root)),
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
  const worker = await Effect.runPromise(
    cloudflare.poolWorkerName(
      { accountId, apiToken, fetch: globalThis.fetch },
      "basalt",
      options.stage,
    ),
  );
  const access = {
    accountId,
    worker,
    // The pool Worker opens handoff envelopes with its deployment key, as the crash dispatcher signs them.
    signingKey: options.env.POOL_DEPLOYMENT_KEY ?? "",
    code: options.code,
    // Reads write no operator packet.
    directory: "",
  };
  return {
    root: async () => fleet.primaryBoot(await controller.inspectController(access)),
    cells: async (root) => fleet.cellBoots(await controller.inspectFleet(access), root),
  };
}
