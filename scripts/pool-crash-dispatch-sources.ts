import { Schema } from "effect";
import type { ControllerCode } from "../src/pool/runtime-slots/contract.ts";
import type { PoolOperationsTarget } from "./pool-operations.ts";
import { BarrierRefusal } from "./release-barrier/refusal.ts";

// Live production sources for the crash dispatch: the run history and the deployed release target.

/** A refused run-list read; only its numeric status reaches the public result. */
export class RunListRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Run list refused with HTTP ${status}`);
    this.status = status;
  }
}

/** The account and PoolWorker script a crash command is sent to. */
export type ReleaseTarget = { accountId: string; worker: string };
/** The root PoolContainer application a legacy slot witness names. */
export type RootApplication = {
  applicationId: string;
  applicationVersion: string;
  imageDigest: string;
  imageInput: string;
};

/** The dispatch title is the only durable record a fresh runner has of earlier nonces. */
export const workflowRunLister =
  (repository: string, token: string, fetcher = globalThis.fetch) =>
  async () => {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !token) throw new Error("No run list access");
    const Page = Schema.Struct({
      workflow_runs: Schema.Array(
        Schema.Struct({ id: Schema.Number, display_title: Schema.String }),
      ),
    });
    const runs: { id: number; displayTitle: string }[] = [];
    for (let page = 1; page <= 50; page++) {
      const response = await fetcher(
        `https://api.github.com/repos/${repository}/actions/workflows/pool-crash-operator.yml/runs?per_page=100&page=${page}`,
        {
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        },
      );
      if (!response.ok) throw new RunListRefused(response.status);
      const body = Schema.decodeUnknownSync(Page)(await response.json());
      runs.push(
        ...body.workflow_runs.map((run) => ({ id: run.id, displayTitle: run.display_title })),
      );
      if (body.workflow_runs.length < 100) return runs;
    }
    throw new Error("Run list exceeded its page limit");
  };

/**
 * The worker comes from Alchemy's script tags and the root from the deployed Worker's own bindings
 * plus a live application read, so no release-layer State reader is needed. While the root is the
 * selected primary, the controller's signed inspect gives its pins exactly as the controller holds them.
 */
export async function readReleaseTarget(
  env: NodeJS.ProcessEnv,
  io: {
    fetch?: typeof globalThis.fetch;
    origin?: string;
    connect?: PoolOperationsTarget["connect"];
    code?: ControllerCode;
  } = {},
): Promise<ReleaseTarget & { root: RootApplication }> {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = env;
  if (!accountId || !apiToken)
    throw new BarrierRefusal("crash-dispatch-release-state-credentials-unavailable", "PoolWorker");
  const [{ Effect }, cloudflare, controller] = await Promise.all([
    import("effect"),
    import("./pool-fleet/cloudflare.ts"),
    import("./pool-fleet/controller.ts"),
  ]);
  const access = { accountId, apiToken, fetch: io.fetch ?? globalThis.fetch, origin: io.origin };
  const { worker, root } = await Effect.runPromise(
    Effect.gen(function* () {
      const worker = yield* cloudflare.poolWorkerName(access);
      const bindings = yield* cloudflare.workerPlainBindings(access, worker);
      const applicationId = yield* cloudflare.requireBinding(
        bindings,
        "POOL_CONTAINER_APPLICATION_ID",
      );
      const imageInput = yield* cloudflare.requireBinding(bindings, "POOL_IMAGE_HASH");
      const application = Schema.decodeUnknownSync(
        Schema.Struct({
          version: Schema.Number,
          configuration: Schema.Struct({ image: Schema.String }),
        }),
      )(yield* cloudflare.containerApplication(access, applicationId));
      return {
        worker,
        root: {
          applicationId,
          applicationVersion: String(application.version),
          // An image without a pinned digest leaves this empty; the witness then reports "not sent".
          imageDigest: application.configuration.image.split("@")[1] ?? "",
          imageInput,
        },
      };
    }),
  );
  const signingKey = env.POOL_DEPLOYMENT_KEY ?? "";
  let selected: RootApplication | undefined;
  try {
    const view = await controller.inspectController({
      accountId,
      worker,
      signingKey,
      code: io.code ?? controller.checkoutControllerCode,
      connect: io.connect,
      directory: "",
    });
    const target = view.selection?.active.target;
    // Only a selection that is still the root container names the root; a promoted cell does not.
    if (target?.applicationId === root.applicationId)
      selected = {
        applicationId: target.applicationId,
        applicationVersion: target.applicationVersion,
        imageDigest: target.imageDigest,
        imageInput: target.imageInput,
      };
  } catch {
    // Signed with this checkout's code; the dispatch's own inspect, signed with the packet's code,
    // reports any refusal. The Worker's bindings still name the root.
  }
  return { accountId, worker, root: selected ?? root };
}
