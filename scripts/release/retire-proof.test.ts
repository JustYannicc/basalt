import assert from "node:assert/strict";
import { test } from "node:test";
import { Cause, Effect, Exit, Redacted } from "effect";
import {
  provenDigests,
  provenRowsDigest,
  provenStageRows,
  retireProofRefusal,
} from "./retire-proof.ts";
import { ownIdentities } from "./stage-writes.ts";

const STACK = "basalt-rehearsal";
const STAGE = "test-rehearsal-1234";
const worker = (fqn: string, workerName: string) => ({
  fqn,
  logicalId: fqn,
  resourceType: "Cloudflare.Worker",
  status: "created",
  attr: { workerName, routes: [{ id: `route-${fqn}`, pattern: "x.rehearsal-1234.example.dev/*" }] },
});
const bucket = (fqn: string, name: string) => ({
  fqn,
  logicalId: fqn,
  resourceType: "Cloudflare.R2.Bucket",
  attr: { name, accountId: "shared-account" },
});
const proven = [
  worker("Api", `basalt-rehearsal-api-${STAGE}`),
  bucket("Files", `basalt-rehearsal-files-${STAGE}`),
];

/** A State store as deploy.ts reads it: list, then get per fqn. */
const store = (rows: ReadonlyArray<{ fqn: string }>) => ({
  state: {
    list: (_request: { stack: string; stage: string }) =>
      Effect.sync(() => rows.map((row) => row.fqn)),
    get: (request: { stack: string; stage: string; fqn: string }) =>
      Effect.sync(() => rows.find((row) => row.fqn === request.fqn)),
  },
});
const handed = (stacks: Record<string, ReadonlyArray<unknown>>) =>
  JSON.stringify(
    provenDigests(
      Object.fromEntries(
        Object.entries(stacks).map(([stack, rows]) => [
          stack,
          rows.map((value) => ({
            path: `${stack}/${STAGE}/${(value as { fqn: string }).fqn}`,
            value,
          })),
        ]),
      ),
      STAGE,
    ),
  );

test("the same rows digest the same on both sides, whatever their order or form", () => {
  // The proof reads rows as the State CLI prints them; the destroy as the store decodes them.
  const printed = JSON.parse(JSON.stringify([...proven].reverse())) as unknown[];
  assert.equal(provenRowsDigest(printed), provenRowsDigest(proven));
  const decoded = { ...bucket("Key", "k"), attr: { name: "k", tokenId: Redacted.make("t") } };
  assert.equal(
    provenRowsDigest([JSON.parse(JSON.stringify(decoded))]),
    provenRowsDigest([decoded]),
  );
  // The stack's output row is no resource; the destroy's read never lists it.
  const withOutput = provenDigests(
    {
      [STACK]: [
        { path: `${STACK}/${STAGE}/output`, value: { url: "x" } },
        ...proven.map((value) => ({ path: `${STACK}/${STAGE}/${value.fqn}`, value })),
      ],
    },
    STAGE,
  );
  assert.equal(withOutput[STACK], provenRowsDigest(proven));
  assert.equal(
    retireProofRefusal(true, handed({ [STACK]: proven }), STACK, STAGE, printed),
    undefined,
  );
});

test("a row added, renamed or retyped since the proof changes the digest", () => {
  const base = provenRowsDigest(proven);
  assert.notEqual(provenRowsDigest([...proven, bucket("Extra", "production-bucket")]), base);
  assert.notEqual(provenRowsDigest([proven[0], bucket("Files", "production-bucket")]), base);
  assert.notEqual(provenRowsDigest([proven[0], { ...proven[1], fqn: "Other" }]), base);
  assert.notEqual(
    provenRowsDigest([proven[0], { ...proven[1], resourceType: "Cloudflare.KV.Namespace" }]),
    base,
  );
  // An interrupted update's old generation is owned too, so it is proven too.
  assert.notEqual(
    provenRowsDigest([proven[0], { ...proven[1], old: { attr: { name: "production-bucket" } } }]),
    base,
  );
  // A field the stage gate never reads changes nothing it uses.
  assert.equal(provenRowsDigest([proven[0], { ...proven[1], status: "updating" }]), base);
});

test("a destroy refuses before planning when its read is not the rows the retire proved", async () => {
  const proof = handed({ [STACK]: proven, "basalt-preview-database": [] });
  for (const [label, rows] of [
    ["a row written since", [...proven, bucket("Late", "production-bucket")]],
    ["an identity changed since", [proven[0], bucket("Files", "production-bucket")]],
  ] as const) {
    const { state } = store(rows);
    const exit = await Effect.runPromiseExit(provenStageRows(state, STACK, STAGE, true, proof));
    assert.ok(Exit.isFailure(exit), label);
    const message = String(Cause.squash(exit.cause));
    assert.match(message, /changed since the retire proved them/u, label);
    // The refusal names no value.
    assert.ok(!message.includes("production-bucket") && !message.includes(STAGE), label);
  }
  // The proof's own rows pass, and they are what the owned set is built from.
  const { state } = store(proven);
  const rows = await Effect.runPromise(provenStageRows(state, STACK, STAGE, true, proof));
  assert.deepEqual(ownIdentities(rows), ownIdentities(proven));
});

test("a stack the proof names no digest for refuses only when State holds rows of it", () => {
  const proof = handed({ [STACK]: proven });
  assert.equal(retireProofRefusal(true, proof, "basalt-preview-database", STAGE, []), undefined);
  assert.match(
    retireProofRefusal(true, proof, "basalt-preview-database", STAGE, [bucket("Late", "x")]) ?? "",
    /proved no rows of this stack/u,
  );
  // A stack proven empty refuses a row that appears in it.
  const empty = handed({ [STACK]: [] });
  assert.ok(retireProofRefusal(true, empty, STACK, STAGE, [bucket("Late", "x")]));
  assert.match(retireProofRefusal(true, "not json", STACK, STAGE, []) ?? "", /could not be read/u);
  assert.match(retireProofRefusal(true, "[]", STACK, STAGE, []) ?? "", /could not be read/u);
});

test("a four-digit stage's destroy without a retire's proof refuses before planning", async () => {
  const { state } = store(proven);
  const exit = await Effect.runPromiseExit(provenStageRows(state, STACK, STAGE, true, undefined));
  assert.ok(Exit.isFailure(exit));
  assert.match(String(Cause.squash(exit.cause)), /destroyed only by a retire/u);
  // Its other commands read as before.
  assert.deepEqual(
    await Effect.runPromise(provenStageRows(state, STACK, STAGE, false, undefined)),
    proven,
  );
});

test("without a retire's proof, lane destroys and PR previews read exactly as before", async () => {
  const late = [...proven, bucket("Late", "anything")];
  // The proof binds only the four-digit stages a retire takes.
  const proof = handed({ [STACK]: proven });
  for (const stage of ["test-rehearsal-2", "test-pr-1951"])
    assert.equal(retireProofRefusal(true, proof, STACK, stage, late), undefined);
  for (const stage of ["test-rehearsal-2", "test-pr-1951"])
    assert.equal(retireProofRefusal(true, undefined, STACK, stage, late), undefined);
  const { state } = store(late);
  assert.deepEqual(
    await Effect.runPromise(provenStageRows(state, STACK, "test-rehearsal-2", true, undefined)),
    late,
  );
});
