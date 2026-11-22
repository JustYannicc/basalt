import assert from "node:assert/strict";
import { Effect } from "effect";

// The installed provider's own metadata hash, from the source or the shipped JavaScript.
const [tree = "lib"] = process.argv.slice(2);
assert.ok(tree === "src" || tree === "lib");
const provider = await import(
  new URL(
    `../../../node_modules/alchemy/${tree}/Cloudflare/Workers/WorkerProvider.${tree === "src" ? "ts" : "js"}`,
    import.meta.url,
  )
);
assert.equal(
  typeof provider.resolveWorkerMetadataHash,
  "function",
  "the metadata hash is exported",
);

// A Worker bound to one Hyperdrive, as the binding layer contributes it: the wire binding the
// upload carries, and the dev-only `hyperdrives` channel beside it.
const binding = (id, host, password) => ({
  sid: "Database",
  data: {
    bindings: [{ type: "hyperdrive", name: "Database", id }],
    hyperdrives: {
      [id]: { scheme: "postgres", host, port: 5432, user: "app", password, database: "app" },
    },
  },
});
const hash = (bindings) =>
  Effect.runPromise(
    provider.resolveWorkerMetadataHash({
      props: { main: "./worker.ts", compatibility: { date: "2026-09-08" } },
      bindings,
      accountId: "0".repeat(32),
      stack: { name: "fixture", stage: "fixture" },
      selfUrl: undefined,
    }),
  );

const reconciled = await hash([binding("hyperdrive-1", "db.internal", "first")]);
// The same Hyperdrive as a later plan reads it back: another origin shape, the same wire binding.
const planned = await hash([binding("hyperdrive-1", "db.internal.example", "second")]);
assert.equal(
  planned,
  reconciled,
  "a dev-only origin difference leaves the metadata hash unchanged",
);
// The upload's own binding still counts.
const rebound = await hash([binding("hyperdrive-2", "db.internal", "first")]);
assert.notEqual(rebound, reconciled, "a different wire binding changes the metadata hash");
// A binding without the channel still hashes its whole data.
const service = (name) => [
  { sid: "Api", data: { bindings: [{ type: "service", name: "Api", service: name }] } },
];
assert.notEqual(
  await hash(service("api")),
  await hash(service("api-next")),
  "a wire difference in a binding without the channel changes the metadata hash",
);
