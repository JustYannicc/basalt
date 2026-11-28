import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  workerDomain,
  workerDomainList,
  workerDomainNotFound,
} from "../pool-fleet/test/cloudflare-shapes.ts";
import { providerReadbacks } from "./provider-absence.ts";

// A local Cloudflare that answers the domain list, page by page, only with recorded shapes.
let pages: unknown[] = [];
const asked: string[] = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://local");
  const page = Number(url.searchParams.get("page") ?? "1");
  asked.push(`${url.pathname.split("/").slice(-2).join("/")}?page=${page}`);
  const body = pages[page - 1];
  response.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
  response.end(JSON.stringify(body ?? workerDomainNotFound("domain-unknown")));
});
let readbacks: ReturnType<typeof providerReadbacks>;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  readbacks = providerReadbacks(
    {
      CLOUDFLARE_ACCOUNT_ID: "fixture-account",
      CLOUDFLARE_API_TOKEN: "fixture-token",
      PLANETSCALE_ORGANIZATION: "fixture",
      PLANETSCALE_API_TOKEN_ID: "fixture",
      PLANETSCALE_API_TOKEN: "fixture",
    },
    `http://127.0.0.1:${port}/client/v4`,
  );
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

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
  // The recorded list with an error in it, without its error list, or without success is not.
  const refusal = workerDomainNotFound("domain-1").errors;
  for (const body of [
    { ...workerDomainList([]), errors: refusal },
    Object.fromEntries(Object.entries(workerDomainList([])).filter(([key]) => key !== "errors")),
    { ...workerDomainList([]), success: false },
  ]) {
    pages = [body];
    await assert.rejects(readbacks.listWorkerDomains(), /not authoritative/);
  }
});

// The multi-page result_info below is written for the test: the recorded list is a single page.
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
  // A page answered again (the page number ignored) never counts toward the total.
  pages = [page(1, [domain(1), domain(2)]), page(1, [domain(1), domain(2)])];
  await assert.rejects(readbacks.listWorkerDomains(), /another page than asked/);
  pages = [page(1, [domain(1), domain(2)]), page(2, [domain(1), domain(2)])];
  await assert.rejects(readbacks.listWorkerDomains(), /repeated a domain/);
  // A total that shrinks between pages (a domain deleted meanwhile) can hide one: refused.
  pages = [
    page(1, [domain(1), domain(2)]),
    { ...workerDomainList([]), result_info: { page: 2, per_page: 2, count: 0, total_count: 2 } },
  ];
  await assert.rejects(readbacks.listWorkerDomains(), /changed while it was read/);
});
