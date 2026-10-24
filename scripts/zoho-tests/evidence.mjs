import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bundlePoolApp } from "../pool-app-bundle.ts";

export const digest = value => createHash("sha256").update(value).digest("hex");

/** Verify the current committed candidate, pinned upstream, carried patches, and generated pool app. */
export function pinProofSource(root, candidateCommit, baseCommit) {
  const gitRoot = args => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  for (const [name, value] of Object.entries({ candidateCommit, baseCommit }))
    assert.match(value ?? "", /^[a-f0-9]{40}$/, name + " must be a full commit hash");
  assert.equal(gitRoot(["rev-parse", "HEAD"]), candidateCommit, "Candidate must match checked-out HEAD");
  assert.equal(gitRoot(["status", "--porcelain"]), "", "Commit or remove candidate changes before proving them");
  gitRoot(["merge-base", "--is-ancestor", baseCommit, candidateCommit]);
  const prepared = verifyZohoProofRuntime(root);
  return {
    candidateCommit,
    baseCommit,
    candidateTree: gitRoot(["rev-parse", "HEAD^{tree}"]),
    runtimeCommit: prepared.commit,
    patches: prepared.patches.map(path => ({
      path,
      sha256: digest(readFileSync(join(root, "patches", path))),
    })),
  };
}

/**
 * This is the source pin used by the Zoho proof. Its scratch reconstruction includes both
 * generated pool contracts so it remains valid after the pool-sharing change.
 */
export function verifyZohoProofRuntime(root) {
  const upstream = join(root, ".upstream");
  const pin = JSON.parse(readFileSync(join(root, "upstream.json"), "utf8"));
  assert.match(pin.commit ?? "", /^[a-f0-9]{40}$/, "Expected an immutable tools runtime pin");
  const git = (args, env = process.env) => execFileSync("git", ["-C", upstream, ...args], {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  assert.equal(git(["rev-parse", "HEAD"]), pin.commit, "Prepared tools runtime does not match upstream.json");
  const patches = readdirSync(join(root, "patches")).filter(file => file.endsWith(".patch")).sort();
  assert.ok(patches.length > 0, "No carried patches found");

  const scratch = mkdtempSync(join(tmpdir(), "basalt-zoho-source-"));
  try {
    const expected = { ...process.env, GIT_INDEX_FILE: join(scratch, "expected-index") };
    const actual = { ...process.env, GIT_INDEX_FILE: join(scratch, "actual-index") };
    git(["read-tree", pin.commit], expected);
    for (const patch of patches) {
      try {
        git(["apply", "--cached", join(root, "patches", patch)], expected);
      } catch {
        throw new Error("Carried patch does not apply: " + patch);
      }
    }
    const additions = git([
      "diff",
      "--cached",
      "--name-only",
      "--diff-filter=A",
      pin.commit,
    ], expected).split("\n").filter(Boolean);

    const generatedRoot = join(scratch, "root");
    const generatedUpstream = join(generatedRoot, ".upstream");
    cpSync(join(root, "apps/pool"), join(generatedRoot, "apps/pool"), {
      recursive: true,
      filter: path => !/(?:^|\/)(?:node_modules|dist)(?:\/|$)/.test(path),
    });
    mkdirSync(join(generatedRoot, "src/pool"), { recursive: true });
    cpSync(join(root, "src/pool/token.ts"), join(generatedRoot, "src/pool/token.ts"));
    cpSync(join(root, "src/pool/access-contract.ts"), join(generatedRoot, "src/pool/access-contract.ts"));
    const framework = join(generatedUpstream, "packages/apps/package.json");
    mkdirSync(dirname(framework), { recursive: true });
    writeFileSync(framework, git(["show", ":packages/apps/package.json"], expected));
    const fonts = "packages/ui/src/implementation/styles/fonts";
    cpSync(join(upstream, fonts), join(generatedUpstream, fonts), { recursive: true });
    bundlePoolApp(generatedRoot, generatedUpstream);

    const generated = [
      "apps/hosted/server/src/implementation/pool-app-source.ts",
      "apps/hosted/server/src/implementation/pool-token.ts",
      "apps/hosted/server/src/implementation/pool-access-contract.ts",
    ];
    for (const path of generated) {
      assert.deepEqual(
        readFileSync(join(upstream, path)),
        readFileSync(join(generatedUpstream, path)),
        "Generated pool runtime source differs from current Basalt source: " + path,
      );
    }

    git(["read-tree", pin.commit], actual);
    git(["add", "-u"], actual);
    if (additions.length) git(["add", "--", ...additions], actual);
    assert.equal(git(["write-tree"], actual), git(["write-tree"], expected),
      "Prepared tools runtime differs from carried patch set");
    const permitted = new Set([...additions, ...generated]);
    const extraRuntimeSource = git(["ls-files", "--others", "--exclude-standard"])
      .split("\n")
      .filter(path => /^(?:apps|packages|e2e)\//.test(path)
        && !path.includes("/scripts/")
        && !permitted.has(path));
    assert.deepEqual(extraRuntimeSource, [], "Unexpected source in prepared tools runtime");
    return { commit: pin.commit, patches };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Hash the exact deployment JSON and each file without retaining source contents in the report. */
export function deploymentPayload(files) {
  return {
    sha256: digest(JSON.stringify(files)),
    files: files.map(({ path, content }) => ({
      path,
      bytes: Buffer.byteLength(content),
      sha256: digest(content),
    })),
  };
}

export const redactDiagnostic = (value, privateValues = []) => {
  let safe = String(value ?? "");
  for (const secret of [...privateValues].filter(Boolean).sort((a, b) => b.length - a.length))
    safe = safe.replaceAll(String(secret), "[redacted]");
  return safe.slice(0, 512);
};

/** Preserve only bounded, sanitized context from a failed native stage. */
export function boundedFailure(stage, error, privateValues = []) {
  const value = error && typeof error === "object" ? error : {};
  return {
    stage: redactDiagnostic(stage, privateValues),
    kind: redactDiagnostic(value.name ?? "Error", privateValues),
    message: redactDiagnostic(value.message ?? error, privateValues),
  };
}

/** Discovery exposes app failures separately from its result paths. */
export function unavailableAppsEvidence(result, privateValues) {
  let body = result.structuredContent;
  if (body === undefined) {
    const text = result.content?.find(item => item?.type === "text")?.text;
    if (typeof text === "string") {
      try { body = JSON.parse(text); } catch { body = undefined; }
    }
  }
  return Array.isArray(body?.unavailableApps) ? body.unavailableApps.slice(0, 20).map(app =>
    Object.fromEntries(["app", "name", "reason", "router"].flatMap(key =>
      typeof app?.[key] === "string" ? [[key, redactDiagnostic(app[key], privateValues)]] : []))) : [];
}

/** Keep MCP protocol failures without credentials or arbitrary successful tool output. */
export function mcpExecutionEvidence(result, privateValues) {
  const text = value => redactDiagnostic(value, privateValues);
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
