import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeReadOnlyHttpStateStore } from "alchemy/State/ReadOnlyHttpStateStore";
import { readOnlyFetch } from "./read-only-runtime.ts";
import {
  SchemaInspectionRefusal,
  withSchemaInspectionContext,
  type SchemaInspectionReason,
} from "./schema-inspection-context.ts";
import { inspectionSqlSource } from "./sql-schema-sources.ts";
import { inspectSqlSchema } from "./sql-schema-inspection.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = new URL("../../.local/schema-inspection/", import.meta.url);
const deadline = AbortSignal.timeout(45_000);
let tooling: string | null = null;
let stage: SchemaInspectionReason = "schema-inspection-untrusted-context";
let receipt:
  | Awaited<ReturnType<typeof inspectSqlSchema>>
  | {
      formatVersion: 1;
      selection: "schema-v1";
      tooling: string | null;
      status: "incomplete";
      reason: SchemaInspectionReason;
      journals: [];
      auth: [];
    };

try {
  const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  }).trim();
  if (/^[a-f0-9]{40}$/u.test(candidate)) tooling = candidate;
  receipt = await withSchemaInspectionContext(
    process.env,
    candidate,
    process.env.BASALT_SCHEMA_INSPECTION_SELECTION ?? "",
    async (context) => {
      stage = "schema-inspection-state-unavailable";
      const fetcher = readOnlyFetch(new URL(context.stateUrl).origin, globalThis.fetch);
      const timedFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        return fetcher(
          new Request(request, {
            signal: AbortSignal.any([request.signal, deadline]),
          }),
        );
      };
      const result = await Effect.runPromiseExit(
        Effect.gen(function* () {
          const state = yield* makeReadOnlyHttpStateStore({
            url: context.stateUrl,
            authToken: Redacted.make(context.token),
            stack: "basalt",
            stage: "production",
            expectedVersion: 8,
          });
          const source = yield* inspectionSqlSource(state);
          stage = "schema-inspection-operation-failed";
          return yield* Effect.tryPromise({
            try: () =>
              inspectSqlSchema({
                selection: context.selection,
                tooling: context.candidate,
                source,
              }),
            catch: () => new SchemaInspectionRefusal("schema-inspection-operation-failed"),
          });
        }).pipe(Effect.provideService(FetchHttpClient.Fetch, timedFetch)),
        { signal: deadline },
      );
      if (Exit.isFailure(result)) throw new SchemaInspectionRefusal(stage);
      return result.value;
    },
  );
  if (Buffer.byteLength(JSON.stringify(receipt)) > 65_536)
    throw new SchemaInspectionRefusal("schema-inspection-receipt-too-large");
} catch (error) {
  receipt = {
    formatVersion: 1,
    selection: "schema-v1",
    tooling,
    status: "incomplete",
    reason: deadline.aborted
      ? "schema-inspection-timeout"
      : error instanceof SchemaInspectionRefusal
        ? error.reason
        : stage,
    journals: [],
    auth: [],
  };
}

try {
  await mkdir(output, { recursive: true, mode: 0o700 });
  await writeFile(new URL("receipt.json", output), `${JSON.stringify(receipt, null, 2)}\n`, {
    mode: 0o600,
  });
  const summary =
    "reason" in receipt
      ? `Production schema inspection incomplete: ${receipt.reason}.`
      : `Production schema inspection ${receipt.status}. Journals observed: ${receipt.journals.filter((entry) => entry.status === "observed").length}/${receipt.journals.length}. Auth tables observed: ${receipt.auth.filter((entry) => entry.status === "observed").length}/${receipt.auth.length}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n\n`);
} catch {
  console.log("Production schema inspection incomplete: schema-inspection-output-failed.");
  process.exitCode = 1;
}
if (receipt.status !== "complete") process.exitCode = 1;
