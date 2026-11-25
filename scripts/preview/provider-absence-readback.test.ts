import assert from "node:assert/strict";
import { test } from "node:test";
import { workerDomain, workerDomainList } from "../pool-fleet/test/cloudflare-shapes.ts";

// The control plane captures fetch at import, so the stand-in is installed before the module loads.
// It serves Cloudflare's recorded Workers custom domain shapes, page by page.
let pages: unknown[] = [];
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  asked.push(`${url.pathname.split("/").slice(-2).join("/")}?page=${url.searchParams.get("page")}`);
  const page = Number(url.searchParams.get("page") ?? "1");
  return Response.json(pages[page - 1] ?? { success: false, errors: [{ code: 1 }] });
}) as typeof fetch;
const { providerReadbacks } = await import("./provider-absence.ts");
const readbacks = providerReadbacks({
  CLOUDFLARE_ACCOUNT_ID: "fixture-account",
  CLOUDFLARE_API_TOKEN: "fixture-token",
  PLANETSCALE_ORGANIZATION: "fixture",
  PLANETSCALE_API_TOKEN_ID: "fixture",
  PLANETSCALE_API_TOKEN: "fixture",
});
const domain = (n: number) => ({
  ...workerDomain,
  id: `domain-${n}`,
  hostname: `h${n}.example.invalid`,
});

test("the Workers custom domain list, as Cloudflare answers it with null errors, is a clean read", async () => {
  pages = [workerDomainList([domain(1)])];
  assert.deepEqual(
    (await readbacks.listWorkerDomains()).map(({ hostname }) => hostname),
    ["h1.example.invalid"],
  );
  // Null or an empty list is clean; an error in it, a missing list, or no success is not.
  for (const body of [
    { ...workerDomainList([]), errors: [{ code: 10000, message: "failed" }] },
    Object.fromEntries(Object.entries(workerDomainList([])).filter(([key]) => key !== "errors")),
    { ...workerDomainList([]), success: false },
  ]) {
    pages = [body];
    await assert.rejects(readbacks.listWorkerDomains(), /not authoritative/);
  }
});

test("the domain list is read to its last page, as its total says", async () => {
  const total = 3;
  const page = (n: number, items: unknown[]) => ({
    ...workerDomainList(items),
    result_info: { page: n, per_page: 2, count: items.length, total_count: total },
  });
  pages = [page(1, [domain(1), domain(2)]), page(2, [domain(3)])];
  asked.length = 0;
  assert.deepEqual(
    (await readbacks.listWorkerDomains()).map(({ id }) => id),
    ["domain-1", "domain-2", "domain-3"],
  );
  assert.deepEqual(asked, ["workers/domains?page=1", "workers/domains?page=2"]);
  // A list that stops before its total proves nothing about the domains it never showed.
  pages = [page(1, [domain(1), domain(2)]), page(2, [])];
  await assert.rejects(readbacks.listWorkerDomains(), /ended before its total/);
});
