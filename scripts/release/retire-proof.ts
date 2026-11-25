/**
 * Closes the gap between a retire's ownership proof and the destroy it starts. The proof reads a
 * stage's State rows; the destroy, in its own process, reads them again for the stage gate's owned
 * set. A row written between the two reads was never proven, so the destroy refuses unless its own
 * read digests to what the proof read. Both sides compute the digest here, so they cannot diverge.
 */
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { ownIdentities, stageRows } from "./stage-writes.ts";

/** Per stack, the digest of the rows the retire proved: JSON `{ "<stack>": "<sha256 hex>" }`. */
export const RETIRE_PROVEN = "BASALT_RETIRE_PROVEN";

/** The stages a retire takes: the four-digit rehearsal stages from before lanes. */
export const isRetireStage = (stage: string) => /^test-rehearsal-[1-9][0-9]{3}$/u.test(stage);

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Every row by its fqn, its kind and the identities the stage gate takes from it, in any order.
 * Rows go through JSON first: the proof reads them as the State CLI prints them, the destroy as the
 * store decodes them (a Redacted value, a Date), and only their JSON is the same on both sides.
 */
export const provenRowsDigest = (rows: ReadonlyArray<unknown>) => {
  const entries = rows
    .map((row) => {
      const plain: unknown = JSON.parse(JSON.stringify(row ?? null));
      const value = record(plain) ? plain : {};
      return JSON.stringify([
        typeof value.fqn === "string" ? value.fqn : null,
        typeof value.resourceType === "string" ? value.resourceType : null,
        ownIdentities([plain]),
      ]);
    })
    .sort();
  return createHash("sha256")
    .update(`[${entries.join(",")}]`)
    .digest("hex");
};

/**
 * Why a destroy's own read of one stack does not match what the retire proved, or undefined when it
 * does or the stage is no retire's. A four-digit stage is destroyed only by a retire, so a destroy
 * there without a proof refuses too. Names no value: no row, identity or digest.
 */
export const retireProofRefusal = (
  destroying: boolean,
  proven: string | undefined,
  stack: string,
  stage: string,
  rows: ReadonlyArray<unknown>,
): string | undefined => {
  if (!destroying || !isRetireStage(stage)) return undefined;
  if (proven === undefined)
    return "This stage is destroyed only by a retire, which proves its rows first; nothing is planned or deleted";
  let digests: unknown;
  try {
    digests = JSON.parse(proven);
  } catch {
    return "The retire's proof could not be read; nothing is planned or deleted";
  }
  if (!record(digests))
    return "The retire's proof could not be read; nothing is planned or deleted";
  const expected = Object.hasOwn(digests, stack) ? digests[stack] : undefined;
  if (expected === undefined && rows.length === 0) return undefined;
  if (typeof expected !== "string")
    return "The retire proved no rows of this stack, yet State holds some; nothing is planned or deleted";
  if (expected !== provenRowsDigest(rows))
    return "This stack's State rows changed since the retire proved them; nothing is planned or deleted";
  return undefined;
};

/**
 * A disposable stage's rows, read once for the stage gate's owned set. A destroy a retire started
 * refuses here, before anything is planned or sent, when the rows are not the ones it proved.
 */
export const provenStageRows = (
  state: Parameters<typeof stageRows>[0],
  stack: string,
  stage: string,
  destroying: boolean,
  proven: string | undefined,
) =>
  Effect.gen(function* () {
    const rows = yield* stageRows(state, stack, stage);
    const refusal = retireProofRefusal(destroying, proven, stack, stage, rows);
    if (refusal) return yield* Effect.die(new Error(refusal));
    return rows;
  });

/**
 * The digests a retire hands its destroy, per stack, from the rows the proof read. The stack's
 * output row is no resource: the destroy's read lists resources only.
 */
export const provenDigests = (
  stacks: Readonly<
    Record<string, ReadonlyArray<{ readonly path: string; readonly value: unknown }>>
  >,
  stage: string,
) =>
  Object.fromEntries(
    Object.entries(stacks).map(([stack, entries]) => [
      stack,
      provenRowsDigest(
        entries.filter(({ path }) => path !== `${stack}/${stage}/output`).map(({ value }) => value),
      ),
    ]),
  );
