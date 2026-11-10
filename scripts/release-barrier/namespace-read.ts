import { ArtifactsHttpFailure } from "../artifacts-http-failure.ts";
import type { ArtifactsApi } from "../ensure-artifacts.ts";

export interface NamespaceRead {
  readonly phase: "preparation" | "pre-activation";
  readonly namespace: "apps" | "vaults";
  readonly page: number;
  readonly attempt: number;
  readonly at: string;
  readonly status: number | null;
  readonly codes: readonly number[];
  readonly ray?: string;
}

export interface NamespaceReadOptions {
  readonly phase?: NamespaceRead["phase"];
  readonly record?: (read: NamespaceRead) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** Only admission's GET can retry. Every response is retained before it can permit progress. */
export function namespaceAdmissionReader(
  api: ArtifactsApi,
  namespace: NamespaceRead["namespace"],
  options: NamespaceReadOptions,
): ArtifactsApi {
  let page = 0;
  return {
    ...api,
    async listNamespaces(cursor) {
      const currentPage = ++page;
      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await api.listNamespaces(cursor, AbortSignal.timeout(10_000)).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const response = result.ok
          ? result.value.response
          : result.error instanceof ArtifactsHttpFailure
            ? result.error.response
            : undefined;
        await options.record?.({
          phase: options.phase ?? "preparation",
          namespace,
          page: currentPage,
          attempt,
          at: new Date().toISOString(),
          status: response?.status ?? null,
          codes: response?.codes ?? [],
          ...(response?.ray ? { ray: response.ray } : {}),
        });
        if (result.ok) return result.value;
        if (
          !(result.error instanceof ArtifactsHttpFailure) ||
          response?.status !== 403 ||
          response.codes.length !== 1 ||
          response.codes[0] !== 10004 ||
          attempt === 3
        )
          throw result.error;
        await (options.wait ?? pause)(attempt * 1000);
      }
      throw new Error("Namespace read attempt budget exhausted");
    },
  };
}
