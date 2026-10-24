import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyConnectorsSource } from "../connectors-source.ts";

export const digest = value => createHash("sha256").update(value).digest("hex");

/** Bind evidence to a clean committed candidate and the exact prepared runtime it uses. */
export function pinProofSource(root, candidateCommit, baseCommit) {
  const git = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  for (const [name, value] of Object.entries({ candidateCommit, baseCommit }))
    assert.match(value ?? "", /^[a-f0-9]{40}$/, `${name} must be a full commit hash`);
  assert.equal(git(["rev-parse", "HEAD"]), candidateCommit, "Candidate must match the checked-out HEAD");
  assert.equal(git(["status", "--porcelain"]), "", "Commit or remove candidate changes before proving them");
  git(["merge-base", "--is-ancestor", baseCommit, candidateCommit]);
  const prepared = verifyConnectorsSource(root);
  return {
    candidateCommit,
    baseCommit,
    candidateTree: git(["rev-parse", "HEAD^{tree}"]),
    runtimeCommit: prepared.commit,
    patches: prepared.patches.map(path => ({ path, sha256: digest(readFileSync(join(root, "patches", path))) })),
  };
}

/** Hash the actual deployment payload, including its adapted package manifest and each file. */
export function deploymentPayload(files) {
  return {
    sha256: digest(JSON.stringify(files)),
    files: files.map(({ path, content }) => ({ path, sha256: digest(content) })),
  };
}

/** Keep protocol failures without credentials or arbitrary successful tool output. */
export function mcpExecutionEvidence(result, privateValues) {
  const text = value => {
    let safe = String(value ?? "");
    for (const secret of privateValues) if (secret) safe = safe.replaceAll(secret, "[redacted]");
    return safe.slice(0, 512);
  };
  const error = value => value && typeof value === "object" ? {
    ...(typeof value.kind === "string" ? { kind: text(value.kind) } : {}),
    ...(typeof value.message === "string" ? { message: text(value.message) } : {}),
  } : undefined;
  let envelope = result.structuredContent;
  if (envelope === undefined) {
    const content = result.content?.find(item => item?.type === "text")?.text;
    if (typeof content === "string") {
      try { envelope = JSON.parse(content); } catch { envelope = undefined; }
    }
  }
  const execution = envelope?.execution;
  if (!execution || typeof execution.ok !== "boolean") return { parsed: false };
  const returned = execution.value === undefined ? [] : Array.isArray(execution.value)
    ? execution.value : [execution.value];
  return {
    parsed: true,
    ...(typeof envelope.status === "string" ? { status: text(envelope.status) } : {}),
    execution: {
      ok: execution.ok,
      ...(error(execution.error) ? { error: error(execution.error) } : {}),
      callOutcomes: returned.flatMap(value =>
        value && typeof value.path === "string" && typeof value.ok === "boolean"
          ? [{ path: text(value.path), ok: value.ok, ...(error(value.error) ? { error: error(value.error) } : {}) }]
          : []),
    },
  };
}
