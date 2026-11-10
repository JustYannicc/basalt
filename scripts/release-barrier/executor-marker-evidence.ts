import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";

const Commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
const Receipt = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  transition: Schema.Struct({
    baseGitCommit: Commit,
    candidateGitCommit: Commit,
    baseToolsCommit: Schema.Literal("f69c667936e4c02c75f9d7cc79fb750c230839b9"),
    candidateToolsCommit: Schema.Literal("2f4c398f3906e0570f0e25a16fa3602329baba29"),
  }),
  attempt: Schema.String,
  marker: Schema.Literal("public.private_executor_settings.key=version"),
  expected: Schema.Literal("4.0.29"),
  observed: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9]+\.[0-9]+\.[0-9]+$/u))),
  outcome: Schema.Literals(["accepted", "refused", "read_failed"]),
  reason: Schema.optionalKey(
    Schema.Literals([
      "missing",
      "multiple_rows",
      "invalid_value",
      "version_mismatch",
      "query_failed",
    ]),
  ),
});

/** Read only this attempt's safe receipt, including when the migration command failed. */
export async function executorMarkerSummary(
  directory: string,
  candidate: string,
  attempt?: string,
) {
  if (!attempt) return "";
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(attempt))
    throw new Error("Executor marker receipt attempt is invalid");
  const path = resolve(directory, `executor-version-${attempt}.json`);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw new Error("Executor marker receipt could not be read");
  }
  let receipt: typeof Receipt.Type;
  try {
    receipt = Schema.decodeUnknownSync(Schema.fromJsonString(Receipt))(source);
    if (receipt.attempt !== attempt || receipt.transition.candidateGitCommit !== candidate)
      throw new Error("Receipt identity mismatch");
    if (receipt.outcome === "accepted" && receipt.observed !== receipt.expected)
      throw new Error("Accepted marker mismatch");
  } catch {
    throw new Error("Executor marker receipt is invalid or belongs to another release");
  }
  const observed = receipt.observed ?? "unavailable";
  return [
    "\n### Executor migration marker\n",
    `- Resource: \`${receipt.marker}\``,
    `- Expected: \`${receipt.expected}\`; observed: \`${observed}\`; outcome: \`${receipt.outcome}\``,
    `- Production base: \`${receipt.transition.baseGitCommit}\`; candidate: \`${candidate}\``,
    `- Tools pin: \`${receipt.transition.baseToolsCommit}\` to \`${receipt.transition.candidateToolsCommit}\``,
    ...(receipt.reason ? [`- Refusal: \`${receipt.reason}\`; migration not started`] : []),
    "",
  ].join("\n");
}
