import { createHash } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { brand } from "../brand.ts";
import { handleCatalog } from "../src/catalog/worker.ts";
import { type OAuthReview, type OAuthEvidence } from "../src/catalog/oauth-policy.ts";
import type { Feed } from "../src/catalog/feed.ts";

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;

/** JSON formatting is immaterial; source file contents and all declaration fields are retained. */
export const catalogDocumentSha256 = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export interface CatalogReadOptions {
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  sleep?: (milliseconds: number) => Promise<unknown>;
  log?: (line: string) => void;
  /** Bounds one try, its request and whole body together. */
  attemptTimeoutMs?: number;
}

/** A publisher document that could not be fetched: unreachable, not changed. */
export class CatalogSourceUnavailable extends Error {}

const attempts = 3;
// The largest documents read here (the index and Google's source) are about 1 MB and arrive in
// well under a second on CI runners, so 20 s per try only ends a stalled read.
const attemptTimeoutMs = 20_000;
const retryable = (status: number) => status >= 500 || status === 429;

/**
 * Reads a publisher document completely. A network failure, a timeout, a 5xx or a 429 is retried
 * after 1 s and then 2 s; any other status is final at once. The body is buffered inside the try,
 * so a connection that drops mid-body is retried too and a later read of it cannot fail.
 */
async function readCompletely(
  input: string | URL | Request,
  init: RequestInit,
  options: CatalogReadOptions,
): Promise<Response> {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? pause;
  const log = options.log ?? ((line: string) => console.error(line));
  const url = input instanceof Request ? input.url : String(input);
  for (let attempt = 1; ; attempt++) {
    // Each try gets its own signal. A caller's signal (the catalog Worker's serving timeout) is
    // replaced, because once it fires it would abort every retry too.
    const signal = AbortSignal.timeout(options.attemptTimeoutMs ?? attemptTimeoutMs);
    let received = false;
    let reason: string;
    try {
      const response = await fetcher(input, { ...init, signal });
      received = true;
      if (!retryable(response.status)) {
        const body = response.body === null ? null : await response.arrayBuffer();
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      reason = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      reason =
        signal.aborted || (error instanceof DOMException && error.name === "TimeoutError")
          ? "request timed out"
          : received
            ? "response body did not complete"
            : "request did not complete";
    }
    if (attempt === attempts)
      throw new CatalogSourceUnavailable(`${reason} after ${attempts} attempts`);
    const wait = 1000 * 2 ** (attempt - 1);
    log(
      `Catalog read ${url} attempt ${attempt}/${attempts} failed (${reason}); retrying in ${wait} ms`,
    );
    await sleep(wait);
  }
}

const read = async (url: string, options: CatalogReadOptions): Promise<unknown> => {
  const response = await readCompletely(url, { redirect: "error" }, options);
  if (!response.ok) throw new CatalogSourceUnavailable(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new CatalogSourceUnavailable("invalid JSON");
  }
};

const failureReason = (error: unknown) =>
  error instanceof CatalogSourceUnavailable ? error.message : "request did not complete";

const bounded = async <A>(items: readonly A[], run: (item: A) => Promise<void>) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
};

/**
 * Exercise the catalog's public handler, including this revision's carried app sources. A source
 * or metadata document that cannot be fetched is recorded with its last failure, never as drift.
 * Throws CatalogSourceUnavailable when the index itself cannot be fetched.
 */
export async function catalogOAuthEvidence(
  reviews: readonly OAuthReview[],
  hostedClients: ReadonlySet<string>,
  options: CatalogReadOptions = {},
) {
  const index = "https://catalog.executor.sh/index.json";
  const official = await read(index, options).catch((error: unknown) => {
    throw new CatalogSourceUnavailable(
      `catalog index is unavailable (${index}: ${failureReason(error)})`,
    );
  });
  const response = await handleCatalog(
    new Request(`https://${brand.host}/catalog/index.json`),
    async () => Response.json(official),
  );
  if (!response.ok) throw new Error("The composed catalog is unavailable");
  const feed: Feed = await response.json();
  const sources = new Map<string, string>();
  const sourceFailures = new Map<string, string>();
  const metadata = new Map<string, { sha256: string; document: unknown }>();
  const metadataFailures = new Map<string, string>();
  const positiveClaims = new Set(
    reviews
      .filter((review) =>
        Object.values(review.methods).some((method) => method.kind !== "deferred"),
      )
      .map((review) => review.entry),
  );
  await bounded(
    feed.apps.filter((entry) => positiveClaims.has(entry.id)),
    async (entry) => {
      // The handler answers 502 for any publisher failure; this keeps the publisher's own reason.
      let failure: string | undefined;
      const source = await handleCatalog(
        new Request(`https://${brand.host}/catalog/apps/${encodeURIComponent(entry.id)}.json`),
        async (input, init) => {
          try {
            const published = await readCompletely(input, init ?? {}, options);
            if (!published.ok) failure = `HTTP ${published.status}`;
            return published;
          } catch (error) {
            failure = failureReason(error);
            throw error;
          }
        },
      );
      if (!source.ok) {
        sourceFailures.set(entry.id, failure ?? `catalog source returned HTTP ${source.status}`);
        return;
      }
      try {
        sources.set(entry.id, catalogDocumentSha256(await source.json()));
      } catch {
        sourceFailures.set(entry.id, "invalid JSON");
      }
    },
  );
  const documents = [
    ...new Set(
      reviews.flatMap((review) =>
        Object.values(review.methods).flatMap((method) =>
          method.kind === "automatic" ? [method.metadata] : [],
        ),
      ),
    ),
  ];
  await bounded(documents, async (url) => {
    try {
      const document = await read(url, options);
      metadata.set(url, { sha256: catalogDocumentSha256(document), document });
    } catch (error) {
      metadataFailures.set(url, failureReason(error));
    }
  });
  const evidence: OAuthEvidence = {
    sources,
    sourceFailures,
    hostedClients,
    metadata,
    metadataFailures,
  };
  return { feed, evidence };
}

/**
 * `changed` and every other problem fail everywhere. An `unavailable` source, one that still
 * could not be fetched after its retries, fails wherever this check gates what ships: full-suite
 * Checks (pushes to main and to batch branches, which feed main) and local runs. Only a pull
 * request's fast lane sets CATALOG_SOURCES_REQUIRED=false and gets warnings instead, because it
 * ships nothing and the batch's full Check re-runs this check before main. A missing or any other
 * value counts as required.
 */
export function catalogOAuthVerdict(
  problems: readonly string[],
  unavailable: readonly string[],
  requiredSetting: string | undefined,
) {
  const required = requiredSetting !== "false";
  return {
    required,
    failed: problems.length > 0 || (required && unavailable.length > 0),
    warnings: required ? [] : [...unavailable],
  };
}
