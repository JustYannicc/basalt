import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical } from "../release-barrier/manifest.ts";
import { SafetyGateError } from "./contracts.ts";
import type { RecordedRecoveryRequest } from "./recorded-recovery.ts";
import { assertBarrierSource, runCommand } from "./release-runner.ts";

export async function prepareRecordedCandidate(options: {
  root: string;
  target: string;
  request: RecordedRecoveryRequest;
  workflowSha: string;
  prepared: boolean;
  run?: typeof runCommand;
}) {
  const { root, target, request } = options;
  const proof = join(target, ".local/recorded-preparation.json");
  const identity = { request, workflowSha: options.workflowSha, root, target };
  if (options.prepared) {
    try {
      if (canonical(JSON.parse(readFileSync(proof, "utf8"))) !== canonical(identity))
        throw new Error();
    } catch {
      throw new SafetyGateError(
        "The prepared recovery environment is missing or does not match this invocation",
      );
    }
    assertCandidate(target, request.candidate);
    return target;
  }
  execFileSync("git", ["fetch", "--no-tags", "origin", request.candidate], {
    cwd: root,
    stdio: "ignore",
  });
  execFileSync("git", ["worktree", "add", "--detach", target, request.candidate], {
    cwd: root,
    stdio: "ignore",
  });
  assertCandidate(target, request.candidate);
  for (const args of [
    ["run", "prepare:upstream"],
    ["run", "build"],
  ]) {
    const result = await (options.run ?? runCommand)("npm", args, target);
    if (!result.started || result.exitCode !== 0)
      throw new SafetyGateError(
        `Recovery candidate ${args[1]} failed; no recovery command was started`,
      );
  }
  assertCandidate(target, request.candidate);
  mkdirSync(join(target, ".local"), { recursive: true, mode: 0o700 });
  writeFileSync(proof, JSON.stringify(identity) + "\n", { flag: "wx", mode: 0o600 });
  return target;
}

function assertCandidate(target: string, candidate: string) {
  try {
    if (
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim() !==
      candidate
    )
      throw new Error();
    execFileSync("git", ["diff", "--quiet", "HEAD"], { cwd: target, stdio: "ignore" });
  } catch {
    throw new SafetyGateError(
      "Recovery candidate checkout differs from its recorded SHA or tracked source",
    );
  }
  assertBarrierSource(target);
}
