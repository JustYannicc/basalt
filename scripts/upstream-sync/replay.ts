import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { retainContractSources } from "./contracts.ts";
import { git, gitResult, resolveCommit } from "./git.ts";
import { retainSyncSnapshot, type SyncSnapshot } from "./snapshot.ts";

type ReplayStep = {
  file: string;
  sha256: string;
  status: "applied" | "failed";
  phase: "clean-additions" | "check" | "apply";
  diagnostic: string;
};

function applyCarry(root: string, patch: string, content: Buffer) {
  const additions = [
    ...content.toString("utf8").matchAll(/--- \/dev\/null\n\+\+\+ b\/(.+)\n/g),
  ].map((match) => match[1]!);
  const operations = [
    ...(additions.length
      ? [{ phase: "clean-additions" as const, args: ["clean", "-f", "--", ...additions] }]
      : []),
    { phase: "check" as const, args: ["apply", "--check", patch] },
    { phase: "apply" as const, args: ["apply", patch] },
  ];
  const diagnostics: string[] = [];
  for (const { phase, args } of operations) {
    const result = gitResult(root, args);
    if (result.stderr) diagnostics.push(result.stderr);
    if (result.status !== 0)
      return { status: "failed" as const, phase, diagnostic: diagnostics.join("\n") };
  }
  return {
    status: "applied" as const,
    phase: "apply" as const,
    diagnostic: diagnostics.join("\n"),
  };
}

function inside(parent: string, child: string) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith("../"));
}

export function strictReplay(
  snapshot: SyncSnapshot,
  options: { objects: string; target: string; output: string },
) {
  if (!/^[a-f0-9]{40}$/.test(options.target))
    throw new Error("Replay target must be an exact commit");
  const objects = realpathSync(options.objects);
  const destination = resolve(options.output);
  const output = join(realpathSync(dirname(destination)), basename(destination));
  if (inside(objects, output) || inside(output, objects))
    throw new Error("Replay evidence must be separate from the input object repository");
  mkdirSync(output, { recursive: false });
  retainSyncSnapshot(snapshot, output);
  const startedAt = new Date().toISOString();
  writeFileSync(
    join(output, "run.json"),
    JSON.stringify(
      {
        mode: "strict",
        target: options.target,
        basalt: snapshot.inventory.basalt.commit,
        inputSha256: snapshot.inventory.inputSha256,
        startedAt,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const scratch = mkdtempSync(join(output, ".source-"));
  const steps: ReplayStep[] = [];
  let phase = "resolve-target";
  let failure: { phase: string; carry: string | null; diagnostic: string } | null = null;
  let targetTree: string | null = null;
  let finalTree: string | null = null;
  let contracts: ReturnType<typeof retainContractSources> | null = null;
  try {
    resolveCommit(objects, options.target);
    phase = "create-source";
    git(scratch, ["init", "--quiet"]);
    git(scratch, ["fetch", "--quiet", "--no-tags", "--depth=1", objects, options.target]);
    git(scratch, ["checkout", "--quiet", "--detach", options.target]);
    targetTree = git(scratch, ["rev-parse", `${options.target}^{tree}`]).trim();
    phase = "apply-carry";
    for (const { record, content } of snapshot.patches) {
      const step = {
        file: record.file,
        sha256: record.content_sha256,
        ...applyCarry(scratch, join(output, "inputs/patches", record.file), content),
      };
      steps.push(step);
      if (step.diagnostic)
        writeFileSync(join(output, `${record.file}.log`), step.diagnostic, { flag: "wx" });
      if (step.status === "failed") {
        failure = { phase: step.phase, carry: step.file, diagnostic: step.diagnostic };
        break;
      }
    }
    if (!failure) {
      phase = "retain-complete-tree";
      git(scratch, ["add", "--all", "--force"]);
      finalTree = git(scratch, ["write-tree"]).trim();
      writeFileSync(
        join(output, "effective.patch"),
        git(scratch, ["diff", "--cached", "--binary", options.target]),
        {
          flag: "wx",
        },
      );
      contracts = retainContractSources(scratch, output);
    }
  } catch (error) {
    failure = {
      phase,
      carry: null,
      diagnostic: error instanceof Error ? error.message : String(error),
    };
  }
  const attempted = new Set(steps.map((step) => step.file));
  const result = {
    formatVersion: 1 as const,
    mode: "strict" as const,
    basalt: snapshot.inventory.basalt,
    inputSha256: snapshot.inventory.inputSha256,
    target: options.target,
    targetTree,
    finalTree,
    carryCount: snapshot.patches.length,
    applied: steps.filter((step) => step.status === "applied").length,
    passed: failure === null && finalTree !== null && steps.length === snapshot.patches.length,
    failure,
    steps,
    unattempted: snapshot.patches
      .map(({ record }) => record.file)
      .filter((file) => !attempted.has(file)),
    contracts,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  // Retention must succeed before any source evidence can be removed.
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  rmSync(scratch, { recursive: true, force: true });
  writeFileSync(join(output, "cleanup.json"), JSON.stringify({ sourceRemoved: true }) + "\n", {
    flag: "wx",
  });
  return result;
}
