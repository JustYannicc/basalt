import { canonical, hash } from "./encoding.ts";
import { productionOperation, type OpsInput } from "./client.ts";
import { failure, OperationFailure } from "./failure.ts";

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function refuse(
  reasonCode:
    | "page_protocol_invalid"
    | "page_sequence_invalid"
    | "page_incomplete"
    | "page_count_bound",
): never {
  throw new OperationFailure({ ...failure("refused", "receipt"), reasonCode });
}

/** One refusal stops the chain. Only a validated new page can authorize the next signed read. */
export async function retainedInventory(
  input: OpsInput,
  fetcher = fetch,
  savePage: (page: Record<string, unknown>, index: number) => void | Promise<void> = () => {},
) {
  const artifacts: Record<string, unknown>[] = [];
  let continuation: unknown;
  let session: string | undefined;
  let builds = 0;
  let references = 0;
  const seen = new Set<string>();
  for (let index = 0; index < 2000; index++) {
    const result = await productionOperation({ ...input, continuation }, fetcher);
    const page = result.pagination;
    const artifact = result.artifact;
    if (
      !record(page) ||
      !record(artifact) ||
      !digest(artifact.sha256) ||
      page.index !== index ||
      typeof page.session !== "string" ||
      !page.session ||
      typeof page.more !== "boolean" ||
      typeof page.complete !== "boolean" ||
      !integer(page.builds, 64) ||
      !integer(page.references, 2000)
    )
      refuse("page_protocol_invalid");
    if (
      (session !== undefined && session !== page.session) ||
      seen.has(artifact.sha256) ||
      (page.more && page.builds === 0)
    )
      refuse("page_sequence_invalid");
    session = page.session;
    seen.add(artifact.sha256);
    await savePage(result, index);
    if (!page.complete) refuse("page_incomplete");
    artifacts.push(artifact);
    builds += page.builds;
    references += page.references;
    if (!page.more) {
      if (result.continuation !== undefined) refuse("page_protocol_invalid");
      return {
        action: "inventory",
        pages: artifacts.length,
        builds,
        references,
        complete: true,
        artifact: {
          format: "basalt-production-inventory-pages-v1",
          sha256: hash(canonical(artifacts)),
          pages: artifacts,
        },
      };
    }
    const next = result.continuation;
    if (
      !record(next) ||
      !digest(next.sha256) ||
      !record(next.sealed) ||
      !record(next.recipient) ||
      next.version !== 1
    )
      refuse("page_protocol_invalid");
    continuation = next;
  }
  refuse("page_count_bound");
}
