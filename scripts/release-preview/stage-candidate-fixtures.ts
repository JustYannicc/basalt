/** Test fixtures: prepared candidate trees as the stage's candidate checks read them. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
export const served = (version: string) => `export const servedFrameworkVersion = "${version}";\n`;
export const build = (version: string) =>
  JSON.stringify({
    "package.json": JSON.stringify({ name: "apps", version }),
    "runtime.json": JSON.stringify({ protocol: 1, version }),
  });

/** The rehearsal-stage handling the heal overlay gave `alchemy.run.ts`, as the stack file reads it. */
export const stackHandling = {
  "alchemy.run.ts": `import * as Alchemy from "alchemy";
import { Stage } from "alchemy/Stage";
import { Effect } from "effect";
import { stackNameForStage } from "./scripts/release-barrier/release-stage.ts";
import { subjectFromStage } from "./scripts/preview/subject.ts";

export default Alchemy.Stack(
  stackNameForStage(process.env.ALCHEMY_STAGE),
  {},
  Effect.gen(function* () {
    const stage = yield* Stage;
    const previewSubject = subjectFromStage(stage);
    const preview = previewSubject === undefined ? undefined : { subject: previewSubject };
    if (preview === undefined) yield* Effect.log("production only");
  }),
);
`,
  "scripts/release-barrier/release-stage.ts": `export const stackNameForStage = (stage: string | undefined) =>
  stage?.startsWith("test-rehearsal-") ? "basalt-rehearsal" : "basalt";
`,
  "scripts/preview/subject.ts": `export const subjectFromStage = (stage: string) =>
  /^test-rehearsal-[0-9]+$/u.test(stage) ? { kind: "rehearsal" } : undefined;
`,
};

const real = (name: string) =>
  readFileSync(new URL(`./stack-fixtures/${name}.fixture`, import.meta.url), "utf8");

/**
 * The heal overlay's own stack file and the stage-only modules it reads, as committed on the heal
 * candidate (`1f8a687fd`'s overlay).
 */
export const healOverlay = () => ({
  "alchemy.run.ts": real("heal-overlay-alchemy.run"),
  "scripts/preview/rehearsal-stage.ts": real("heal-overlay-rehearsal-stage"),
  "infrastructure/public-site-waitlist.ts": real("heal-overlay-public-site-waitlist"),
});

/** Main's stack file without the overlay: production's stack by name, previews only for PRs. */
export const mainStack = () => ({ "alchemy.run.ts": real("main-alchemy.run") });

export async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), body);
  }
}

/**
 * A prepared candidate at `dir`: its own repository, with `.upstream` its own checkout at
 * `upstream.json`, the overlay's rehearsal-stage handling and, unless `built` is false, a framework
 * build of `version`.
 */
export async function preparedTreeAt(
  dir: string,
  version: string,
  { built = true, stack = stackHandling }: { built?: boolean; stack?: Record<string, string> } = {},
) {
  const upstream = join(dir, ".upstream");
  await mkdir(upstream, { recursive: true });
  git(upstream, "init", "-q");
  git(upstream, "commit", "-q", "--allow-empty", "-m", `upstream for ${dir}`);
  const commit = git(upstream, "rev-parse", "HEAD");
  await writeFile(join(dir, "upstream.json"), JSON.stringify({ commit }));
  await writeFile(join(dir, "framework-release.ts"), served(version));
  await writeFiles(dir, stack);
  if (built) {
    await mkdir(join(upstream, ".local/basalt-framework"), { recursive: true });
    await writeFile(join(upstream, ".local/basalt-framework/framework.json"), build(version));
  }
  git(dir, "init", "-q");
  git(dir, "add", "upstream.json", "framework-release.ts");
  git(dir, "commit", "-q", "-m", "candidate");
  return { dir, upstream, commit };
}

export const preparedTree = (
  at: string,
  name: string,
  version: string,
  options?: Parameters<typeof preparedTreeAt>[2],
) => preparedTreeAt(join(at, name), version, options);

export type Decoded = { version: string; store?: string; patch?: string };

/** A prepared tree's cloud app resolving alchemy and effect through bun's store, as installed. */
export async function decoderTree(at: string, packages: Record<string, Decoded>) {
  const upstream = join(at, ".upstream");
  for (const [name, { version, store = `${name}@${version}`, patch }] of Object.entries(packages)) {
    const installed = join(upstream, "node_modules/.bun", store, "node_modules", name);
    await mkdir(installed, { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify({ name, version }));
    const linked = join(upstream, "apps/hosted/cloud/node_modules");
    await mkdir(linked, { recursive: true });
    await symlink(installed, join(linked, name));
    if (patch !== undefined) {
      await mkdir(join(upstream, "patches"), { recursive: true });
      await writeFile(join(upstream, "patches", `${name}@${version}.patch`), patch);
    }
  }
  return at;
}

/** One per-file section of a composed patch. */
export const section = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${body}\n`;

/** A release entry that only records that it ran. */
export async function markingEntry(dir: string) {
  await mkdir(join(dir, "scripts/release"), { recursive: true });
  await writeFile(
    join(dir, "scripts/release/deploy.ts"),
    'import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("../../entry-ran", import.meta.url), "ran");\n',
  );
  return join(dir, "entry-ran");
}
