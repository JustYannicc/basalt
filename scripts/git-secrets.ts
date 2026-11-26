import { execFileSync } from "node:child_process";

const secretName = /(?:^|_)(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS?)(?:_|$)/i;
const measurementPath = /(?:^|\/)cloud\/(?:scripts|\.local)\/basalt-worker-sizes\.ts$/;
const carriedPath = /^diff --git a\/(\S+) b\/(\S+)$/gm;

interface Finding {
  readonly file: string;
  readonly source: string;
  readonly reason: string;
}

/** Inspect Git objects so a removed literal in an earlier new commit cannot escape the gate. */
export function checkGitSecrets(input: {
  readonly root: string;
  readonly base?: string | undefined;
  readonly head?: string | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: input.root, maxBuffer: 128 * 1024 * 1024 });
  const secrets = Object.entries(input.environment).flatMap(([name, value]) =>
    secretName.test(name) && value
      ? [{ name, values: [...new Set([value, JSON.stringify(value).slice(1, -1)])] }]
      : [],
  );
  const findings: Finding[] = [];
  const inspected = new Map<string, readonly string[]>();
  const inspect = (file: string, oid: string, source: string) => {
    if (/^0+$/.test(oid)) return;
    if (measurementPath.test(file))
      findings.push({ file, source, reason: "generated Worker measurement file" });
    let reasons = inspected.get(oid);
    if (reasons === undefined) {
      const content = git(["cat-file", "blob", oid]);
      const found: string[] = [];
      for (const { name, values } of secrets)
        if (values.some((value) => content.includes(Buffer.from(value))))
          found.push(`literal value from secret-named environment variable ${name}`);
      for (const match of content.toString("utf8").matchAll(carriedPath))
        if (measurementPath.test(match[1]!) || measurementPath.test(match[2]!))
          found.push("carried generated Worker measurement file");
      reasons = [...new Set(found)];
      inspected.set(oid, reasons);
    }
    for (const reason of reasons) findings.push({ file, source, reason });
  };
  const inspectDiff = (args: string[], source: string) => {
    const fields = git(args).toString("utf8").split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const metadata = fields[i]!.split(" ");
      if (metadata[4] !== "D") inspect(fields[i + 1]!, metadata[3]!, source);
    }
  };
  inspectDiff(["diff", "--cached", "--raw", "--no-abbrev", "--no-renames", "-z"], "staged");
  const head = input.head || "HEAD";
  const base = input.base || pushBase(input.root);
  if (base) {
    const commits = git(["rev-list", "--reverse", `${base}..${head}`])
      .toString("utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const commit of commits)
      inspectDiff(
        [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "-r",
          "-m",
          "--raw",
          "--no-abbrev",
          "--no-renames",
          "-z",
          commit,
        ],
        `commit ${commit.slice(0, 12)}`,
      );
  } else {
    for (const entry of git(["ls-tree", "-rz", head]).toString("utf8").split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      const [, type, oid] = entry.slice(0, tab).split(" ");
      if (type === "blob") inspect(entry.slice(tab + 1), oid!, head);
    }
  }
  return findings;
}

/**
 * The base for a run that was given none, as a local preflight is: origin/main itself, so the run
 * reads exactly the commits a push would add, one whose file a later commit removed included. A
 * merge base would read more on a branch with several. With no origin/main there is none, and the
 * check reads the whole tree instead.
 */
function pushBase(root: string) {
  try {
    const base = execFileSync(
      "git",
      ["rev-parse", "--verify", "-q", "refs/remotes/origin/main^{commit}"],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return base || undefined;
  } catch {
    return undefined;
  }
}

export const gitSecretReport = (findings: readonly Finding[]) =>
  findings.map(({ file, source, reason }) => `${file}: refused ${reason} (${source})`).join("\n");
