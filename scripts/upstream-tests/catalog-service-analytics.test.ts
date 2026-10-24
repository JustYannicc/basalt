import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const upstreamRoot = resolve(projectRoot, ".upstream");
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { build } = require("esbuild") as typeof import("esbuild");

const bundle = await build({
  stdin: {
    contents: `
      export { Effect } from "effect";
      export { observeToolSearch } from "./apps/hosted/server/src/implementation/product-analytics.ts";
      export { HostedCatalog } from "./apps/hosted/server/src/contracts/catalog.ts";
      export { ProductAnalytics } from "./apps/hosted/server/src/contracts/product-analytics.ts";
      export { CurrentUserId } from "./apps/hosted/server/src/contracts/auth.ts";
    `,
    resolveDir: upstreamRoot,
    sourcefile: "catalog-service-analytics-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
});
const { Effect, HostedCatalog, CurrentUserId, ProductAnalytics, observeToolSearch } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.text).toString("base64")}`
);

const emptyPage = { items: [], remaining: 0, missing: [] };

const entry = (id: string, name: string, packageName: string) => ({
  id,
  name,
  package: packageName,
  description: "Synthetic catalog fixture.",
  auth: [],
  icons: [],
});

const runSearch = async ({
  query,
  offset = 0,
  page = emptyPage,
  listing = Effect.succeed([]),
  includeCatalog = true,
}: {
  query: string;
  offset?: number;
  page?: { items: unknown[]; remaining: number; missing: unknown[] };
  listing?: unknown;
  includeCatalog?: boolean;
}) => {
  const captured: unknown[] = [];
  let effect = observeToolSearch({ query, offset }, Effect.succeed(page));

  if (includeCatalog) {
    effect = effect.pipe(
      Effect.provideService(
        HostedCatalog,
        HostedCatalog.of({
          list: listing,
          prepare: () => Effect.fail(new Error("unused fixture operation")),
          custom: () => Effect.fail(new Error("unused fixture operation")),
        }),
      ),
    );
  }

  effect = effect.pipe(
    Effect.provideService(ProductAnalytics, {
      enabled: true,
      capture: (event: unknown) => captured.push(event),
      submitFeedback: () => Effect.void,
    }),
    Effect.provideService(CurrentUserId, "actor-fixture"),
  );
  await Effect.runPromise(effect);
  return captured as Array<{
    event: string;
    properties: Record<string, unknown>;
  }>;
};

const assertSafeCapture = (
  captured: Array<{ event: string; properties: Record<string, unknown> }>,
  serviceId: string | undefined,
  forbidden: string[] = [],
) => {
  assert.equal(captured.length, 1, "the baseline miss event is emitted once");
  assert.equal(captured[0]?.event, "tool_search_empty");
  assert.equal(captured[0]?.properties.result_count, 0);
  assert.equal(captured[0]?.properties.service_id, serviceId);
  if (serviceId !== undefined) assert.match(serviceId, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u);

  const serialized = JSON.stringify(captured);
  for (const value of forbidden)
    assert.equal(serialized.includes(value), false, `sink leaked ${value}`);
  for (const field of ["query", "snippet", "email", "message", "credential", "token"])
    assert.equal(Object.hasOwn(captured[0]!.properties, field), false, `sink added ${field}`);
};

test("matches a safe catalog service ID case-insensitively", async () => {
  const captured = await runSearch({
    query: "MAIL-SERVICE",
    listing: Effect.succeed([entry("mail-service", "Private Mail App", "@fixture/private-mail")]),
  });
  assertSafeCapture(captured, "mail-service", [
    "MAIL-SERVICE",
    "Private Mail App",
    "@fixture/private-mail",
  ]);
});

test("matches a containing phrase against a catalog name without exporting query content", async () => {
  const query =
    "Please use pRiVaTe MaIl ApP for alice@example.invalid; token=fixture-secret-77; private note";
  const captured = await runSearch({
    query,
    listing: Effect.succeed([entry("mail-service", "Private Mail App", "@fixture/private-mail")]),
  });
  assertSafeCapture(captured, "mail-service", [
    query,
    "alice@example.invalid",
    "fixture-secret-77",
    "private note",
    "Private Mail App",
    "@fixture/private-mail",
  ]);
});

test("matches a catalog package case-insensitively", async () => {
  const captured = await runSearch({
    query: "install @FIXTURE/PRIVATE-MAIL please",
    listing: Effect.succeed([entry("mail-service", "Private Mail App", "@fixture/private-mail")]),
  });
  assertSafeCapture(captured, "mail-service", ["@FIXTURE/PRIVATE-MAIL", "Private Mail App"]);
});

test("does not infer a service from an email local part or domain", async () => {
  const localPart = await runSearch({
    query: "calendar-admin@example.invalid",
    listing: Effect.succeed([entry("calendar", "Calendar", "@fixture/calendar")]),
  });
  assertSafeCapture(localPart, undefined, ["calendar-admin@example.invalid"]);

  const domain = await runSearch({
    query: "person@calendar.example.invalid",
    listing: Effect.succeed([entry("calendar", "Calendar", "@fixture/calendar")]),
  });
  assertSafeCapture(domain, undefined, ["person@calendar.example.invalid"]);
});

test("leaves unknown and ambiguous catalog matches unclassified", async () => {
  const entries = [
    entry("mail-service", "Private Mail App", "@fixture/private-mail"),
    entry("calendar", "Calendar Service", "@fixture/calendar"),
  ];
  const unknown = await runSearch({
    query: "no catalog service is named here",
    listing: Effect.succeed(entries),
  });
  assertSafeCapture(unknown, undefined, ["no catalog service is named here"]);

  const ambiguous = await runSearch({
    query: "please use Private Mail App and Calendar Service",
    listing: Effect.succeed(entries),
  });
  assertSafeCapture(ambiguous, undefined, ["Private Mail App", "Calendar Service"]);
});

test("rejects catalog IDs outside the safe service slug format", async () => {
  const captured = await runSearch({
    query: "Unsafe Service",
    listing: Effect.succeed([entry("service/unsafe", "Unsafe Service", "@fixture/unsafe")]),
  });
  assertSafeCapture(captured, undefined, ["Unsafe Service", "@fixture/unsafe"]);
});

test("keeps the baseline event when the catalog service is absent or its listing fails", async () => {
  const absent = await runSearch({ query: "unknown service", includeCatalog: false });
  assertSafeCapture(absent, undefined, ["unknown service"]);

  const failed = await runSearch({
    query: "unknown service",
    listing: Effect.fail(new Error("synthetic catalog failure")),
  });
  assertSafeCapture(failed, undefined, ["unknown service", "synthetic catalog failure"]);
});

test(
  "catalog latency is bounded and falls back to the baseline event",
  { timeout: 2_000 },
  async () => {
    const captured = await runSearch({ query: "Private Mail App", listing: Effect.never });
    assertSafeCapture(captured, undefined, ["Private Mail App"]);
  },
);

test("browsing, paginated, matched, and lost-listing searches do not emit empty-search events", async () => {
  let listingCalls = 0;
  const listing = Effect.sync(() => {
    listingCalls++;
    return [entry("mail-service", "Private Mail App", "@fixture/private-mail")];
  });
  const cases = [
    { query: "", offset: 0, page: emptyPage },
    { query: "   ", offset: 0, page: emptyPage },
    { query: "Private Mail App", offset: 10, page: emptyPage },
    { query: "Private Mail App", offset: 0, page: { ...emptyPage, items: [{}] } },
    { query: "Private Mail App", offset: 0, page: { ...emptyPage, remaining: 1 } },
    { query: "Private Mail App", offset: 0, page: { ...emptyPage, missing: ["listing"] } },
  ];

  for (const input of cases) {
    const captured = await runSearch({ ...input, listing });
    assert.deepEqual(captured, []);
  }
  assert.equal(listingCalls, 0, "non-miss searches do not read the catalog");
});

test("overlong queries keep the baseline event and skip catalog lookup", async () => {
  let listingCalls = 0;
  const captured = await runSearch({
    query: "x".repeat(257),
    listing: Effect.sync(() => {
      listingCalls++;
      return [entry("mail-service", "Private Mail App", "@fixture/private-mail")];
    }),
  });
  assertSafeCapture(captured, undefined, ["x".repeat(257)]);
  assert.equal(listingCalls, 0);
});
