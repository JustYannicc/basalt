import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const within = (parent: string, child: string) => child.startsWith(`${parent}${sep}`);

/** Copy selected regular evidence only; runtime package links and database state are never evidence. */
function copyEvidence(source: string, destination: string, full: boolean) {
  let files = 0;
  const visit = (directory: string, inReport = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name),
        rel = relative(source, path);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === "scenarios" && !inReport) {
          for (const scenario of readdirSync(path, { withFileTypes: true }))
            if (scenario.isDirectory()) visit(join(path, scenario.name));
        } else if (
          inReport ||
          ["cloud", "local", "self-host", "report", "diagnostics"].includes(entry.name)
        )
          visit(path, inReport || entry.name === "report");
      } else if (
        entry.isFile() &&
        (inReport ||
          /^(?:evidence|results|result|run|trace-ids)\.json$/.test(entry.name) ||
          /^(?:server|cloud[^/]*|[a-z-]*postgres)\.log$/.test(entry.name) ||
          (full && /\.(?:png|webm|mp4|zip)$/.test(entry.name)))
      ) {
        mkdirSync(dirname(join(destination, rel)), { recursive: true, mode: 0o700 });
        copyFileSync(path, join(destination, rel));
        files++;
      }
    }
  };
  visit(source);
  return files;
}

export function finalizeE2e(
  root: string,
  run: string,
  outcome: string,
  options = {
    ci: process.env.CI === "true" || process.env.BASALT_E2E_EXPORT === "1",
    retain: process.env.BASALT_E2E_RETAIN,
    artifacts: join(homedir(), ".codex/artifacts"),
  },
) {
  root = resolve(root);
  run = resolve(run);
  const runs = join(root, ".upstream/.local/e2e");
  if (dirname(run) !== runs || !lstatSync(run).isDirectory() || lstatSync(run).isSymbolicLink())
    throw new Error("Refusing to finalize a directory outside this checkout's E2E run root");
  const owner = JSON.parse(readFileSync(join(run, ".basalt-run-owner.json"), "utf8")) as {
    pid: number;
  };
  if (owner.pid !== process.ppid && owner.pid !== process.pid)
    throw new Error("Only the owning runner may finalize its evidence");
  const name = basename(run);
  const records = join(root, ".generated/e2e-records");
  mkdirSync(records, { recursive: true, mode: 0o700 });
  const verdict = {
    run: name,
    outcome: outcome === "passed" ? "passed" : "failed",
    recordedAt: new Date().toISOString(),
    evidenceRecorded: existsSync(join(run, "evidence.json")),
  };
  let destination: string | undefined;
  if (options.ci) destination = join(root, ".generated/e2e-evidence", name);
  else if (options.retain) {
    const retention = resolve(options.retain);
    if (!within(resolve(options.artifacts), retention))
      throw new Error("Retained evidence must live under ~/.codex/artifacts");
    mkdirSync(options.artifacts, { recursive: true, mode: 0o700 });
    let parent = resolve(options.artifacts);
    for (const component of relative(parent, retention).split(sep)) {
      parent = join(parent, component);
      if (existsSync(parent) && lstatSync(parent).isSymbolicLink())
        throw new Error("Retention paths must not traverse symbolic links");
    }
    destination = join(retention, name);
  }
  if (destination) {
    if (existsSync(destination))
      throw new Error("Evidence destination already exists; original run preserved");
    const pending = `${destination}.pending-${process.pid}`;
    mkdirSync(pending, { recursive: true, mode: 0o700 });
    try {
      const files = copyEvidence(run, pending, Boolean(options.retain));
      writeFileSync(join(pending, "retention.json"), JSON.stringify({ ...verdict, files }), {
        mode: 0o600,
      });
      renameSync(pending, destination);
    } catch (error) {
      rmSync(pending, { recursive: true, force: true });
      throw error;
    }
  }
  writeFileSync(
    join(records, `${name}.json`),
    JSON.stringify({ ...verdict, ...(destination ? { destination } : {}) }),
    { mode: 0o600 },
  );
  rmSync(run, { recursive: true });
  console.log(
    `E2E ${verdict.outcome}: ${name}. ${destination ? `Selected evidence retained at ${destination}.` : "Summary recorded; temporary run pruned."}`,
  );
  return verdict;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, run, outcome] = process.argv.slice(2);
  if (!root || !run || !outcome) throw new Error("Expected checkout, completed run and verdict");
  finalizeE2e(root, run, outcome);
}
