import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Data, Effect } from "effect";
import type { StateService } from "alchemy/State/State";
import { State } from "alchemy/State/State";
import { readSqlSchemaJournal } from "../release-barrier/sql-schema-journal.ts";

/**
 * The retired release layer kept its journals, archives and receipts as stack outputs under
 * `basalt-<suffix>` side stacks, plus two maps inside the `basalt` stack's own output. A plain
 * Alchemy plan never lists them (it lists resource rows only), and its first full apply rewrites the
 * `basalt` output. This exports each record once, still sealed, before anything applies.
 */
export class LegacyRecordRefusal extends Data.TaggedError("LegacyRecordRefusal")<{
  readonly check: string;
  readonly why: string;
  readonly fix: string;
  readonly detail?: Record<string, unknown>;
  readonly cause?: unknown;
}> {}

const known = [
  "basalt-release-barrier",
  "basalt-runtime-image-release",
  "basalt-sql-schema-barrier",
  "basalt-migration-activation",
  "basalt-placement-repair",
];
const families = [
  "basalt-release-settlement-",
  "basalt-provisioning-archive-",
  "basalt-runtime-image-release-",
];
const embedded = ["$basaltDeclaredChanges", "$basaltDeclaredClasses"];

/** AES-256-GCM under a key derived from the deployment encryption key: CI artifacts of a public repo
 *  must hold only ciphertext, even for records that are not themselves sealed. */
export function sealRecord(plaintext: string, key: string, record: string) {
  // A short or non-hex key would derive from fewer bytes than it looks like it has.
  if (!/^[0-9a-f]{64}$/iu.test(key))
    throw new Error("The encryption key must be 64 hex characters");
  const derived = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(key, "hex"),
      Buffer.from(record),
      "basalt-legacy-records-v1",
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  cipher.setAAD(Buffer.from(record));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: "basalt-legacy-record-v1",
    record,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/** Writes every legacy record to `directory` (one sealed file each) and returns their plaintext digests. */
export const exportLegacyRecords = (
  state: StateService,
  stage: string,
  directory: string,
  key: string,
  // Archive stacks are named by digests of their release pairs; a store may not list output-only
  // stacks, so the caller names the ones it knows and the export reports what it found.
  extra: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const stacks = yield* state.listStacks();
    const names = [
      ...new Set([
        ...known,
        ...extra,
        ...stacks.filter((name) => families.some((prefix) => name.startsWith(prefix))),
      ]),
    ].sort();
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    const exported: { record: string; sha256: string; bytes: number }[] = [];
    const save = (record: string, value: unknown) =>
      Effect.promise(async () => {
        const text = `${JSON.stringify(value)}\n`;
        await writeFile(
          join(directory, `${record.replace(/[^A-Za-z0-9._-]/gu, "_")}.json`),
          JSON.stringify(sealRecord(text, key, record)),
          { mode: 0o600 },
        );
        exported.push({
          record,
          sha256: createHash("sha256").update(text).digest("hex"),
          bytes: text.length,
        });
      });
    for (const stack of names) {
      const value = yield* state.getOutput({ stack, stage });
      if (value !== undefined) yield* save(stack, value);
    }
    const output = (yield* state.getOutput({ stack: "basalt", stage })) as
      | Record<string, unknown>
      | undefined;
    for (const key of embedded)
      if (output && key in output) yield* save(`basalt.${key}`, output[key]);
    return exported;
  });

/**
 * Home's schema step: the retired layer kept an `unresolvedHome` receipt when a Home migration's
 * outcome was unknown. The cutover must not start while one is open.
 */
export const assertNoUnresolvedHome = (
  stage: string,
  key: string,
  // The retired layer's own reader (tested there); replaceable so the refusal itself can be tested.
  read: (
    stack: { name: string; stage: string },
    key: string,
  ) => Effect.Effect<
    { unresolvedHome: { intentId?: string; targetVersion: number } | null } | undefined,
    unknown,
    State
  > = readSqlSchemaJournal,
) =>
  read({ name: "basalt", stage }, key).pipe(
    // The reader throws on a record it cannot decode; any failure or defect means "unknown".
    Effect.catchCause((cause) =>
      Effect.fail(
        new LegacyRecordRefusal({
          check: "home-schema-receipt-unreadable",
          why: "The Home schema receipt could not be read, so an unresolved Home migration cannot be ruled out.",
          fix: "Read basalt-sql-schema-barrier by hand before the cutover.",
          cause,
        }),
      ),
    ),
    Effect.flatMap((journal) =>
      journal?.unresolvedHome
        ? Effect.fail(
            new LegacyRecordRefusal({
              check: "home-schema-unresolved",
              why: "A Home schema migration's outcome is still unknown.",
              fix: "Resolve that migration before any deploy boots a Home against the pool database.",
              detail: {
                intentId: journal.unresolvedHome.intentId,
                targetVersion: journal.unresolvedHome.targetVersion,
              },
            }),
          )
        : Effect.void,
    ),
  );

/** The State rows a plan of `basalt/<stage>` sees, with what Alchemy would do to the undeclared ones. */
export const stateRows = (state: StateService, stage: string) =>
  Effect.gen(function* () {
    const fqns = yield* state.list({ stack: "basalt", stage });
    const rows: { fqn: string; type: string; status: string; removalPolicy: string }[] = [];
    for (const fqn of fqns) {
      const row = (yield* state.get({ stack: "basalt", stage, fqn })) as
        | Record<string, unknown>
        | undefined;
      rows.push({
        fqn,
        type: String(row?.resourceType ?? "unknown"),
        status: String(row?.status ?? "unknown"),
        removalPolicy: String(row?.removalPolicy ?? "destroy"),
      });
    }
    return rows;
  });

export { State };
