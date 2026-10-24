import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { stackFingerprint } from "./fingerprint.ts";
const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "architecture-fingerprint-"));
  temporary.push(root);
  const write = (file: string, source: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  };
  write("alchemy.run.ts", 'import { settings } from "./settings.ts"; new URL("./src/router.ts", import.meta.url); export default settings;');
  write("settings.ts", 'export const settings = { region: "eu" };');
  write("src/router.ts", 'import type { $ElementId } from "../scripts/architecture/gen/model.ts"; export default {};');
  return { root, write };
}
test("the stack fingerprint is independent of the checkout path", () => {
  expect(stackFingerprint(fixture().root)).toBe(stackFingerprint(fixture().root));
});
test("resource settings and referenced configuration change the fingerprint", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("settings.ts", 'export const settings = { region: "other" };');
  expect(stackFingerprint(root)).not.toBe(before);
});
test("runtime source URLs and carried patches participate in the fingerprint", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("src/router.ts", "export default { fetch() {} };");
  const changed = stackFingerprint(root);
  expect(changed).not.toBe(before);
  write("patches/change.patch", "deployment change");
  expect(stackFingerprint(root)).not.toBe(changed);
});
test("generated model types cannot feed back into deployment generation", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("scripts/architecture/gen/model.ts", 'export type $ElementId = "gateway";');
  expect(stackFingerprint(root)).toBe(before);
});


test("deployment environment mapping participates even when resource names do not change", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write("scripts/environment.ts", 'export const deployment = { region: "changed" };');
  expect(stackFingerprint(root)).not.toBe(before);
});

test("container context inputs from every stage participate in deployment drift", () => {
  const { root, write } = fixture();
  write("alchemy.run.ts", 'new URL("./containers/pool/", import.meta.url);');
  write("containers/pool/Dockerfile", "FROM python AS build\nCOPY releases.json fetch.py ./\nFROM python\nCOPY runtime.py ./\n");
  write("containers/pool/releases.json", "{}");
  write("containers/pool/fetch.py", "# release acquisition");
  write("containers/pool/runtime.py", "# runtime");
  for (const file of ["releases.json", "fetch.py", "runtime.py", "Dockerfile"]) {
    const before = stackFingerprint(root);
    const path = `containers/pool/${file}`;
    write(path, readFileSync(join(root, path), "utf8") + "\n# changed\n");
    expect(stackFingerprint(root), file).not.toBe(before);
  }
});

test("referenced public assets hash their bytes and include newly added files", () => {
  const { root, write } = fixture();
  write("alchemy.run.ts", 'new URL("./public/", import.meta.url);');
  write("public/logo.png", "");
  writeFileSync(join(root, "public/logo.png"), Buffer.from([0xff]));
  const before = stackFingerprint(root);
  writeFileSync(join(root, "public/logo.png"), Buffer.from([0xfe]));
  const changed = stackFingerprint(root);
  expect(changed).not.toBe(before);
  write("public/redirects", "/old /new 302");
  const withRedirect = stackFingerprint(root);
  expect(withRedirect).not.toBe(changed);
  write("public/.well-known/config.json", "{}");
  expect(stackFingerprint(root)).not.toBe(withRedirect);
});

test("ignored generated public assets stay out while source and new public assets stay in", () => {
  const { root, write } = fixture();
  const repositoryIgnore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");
  write(".gitignore", `${repositoryIgnore}\npublic/tracked-source.txt\n`);
  write("alchemy.run.ts", 'new URL("./public/", import.meta.url);');
  write("src/setup/client.mjs", "export const installer = 'source';");
  write("src/setup/ui.tsx", "export const page = 'source';");
  write("scripts/setup-build.ts", "build({ entryPoints: ['src/setup/ui.tsx'] });");
  write("apps/pool/ui/style.css", "source styles");
  write("public/tracked-source.txt", "tracked source");
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8" });
  if (initialized.status !== 0) throw new Error(initialized.stderr || "Could not initialize Git fixture");
  const tracked = spawnSync("git", ["add", "-f", "public/tracked-source.txt"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) throw new Error(tracked.stderr || "Could not track fixture asset");

  const beforeGeneratedOutput = stackFingerprint(root);
  write("public/setup/main.js", "built setup bundle");
  write("public/brand/fonts/geist-sans.woff2", "copied font");
  write("src/setup/client.test.ts", "test-only fixture");
  expect(stackFingerprint(root)).toBe(beforeGeneratedOutput);

  write("public/.well-known/config.json", "{}");
  const withWellKnownSource = stackFingerprint(root);
  expect(withWellKnownSource).not.toBe(beforeGeneratedOutput);

  write("public/new-source.txt", "new source asset");
  const withNewSource = stackFingerprint(root);
  expect(withNewSource).not.toBe(withWellKnownSource);

  write("public/global-excluded.txt", "source ignored only by global rules");
  write("public/local-excluded.txt", "source ignored only by repository local excludes");
  const withExternalIgnoreSource = stackFingerprint(root);
  expect(withExternalIgnoreSource).not.toBe(withNewSource);
  write(".git/global-excludes", "public/global-excluded.txt\n");
  const globalExcludes = spawnSync("git", ["config", "core.excludesFile", join(root, ".git/global-excludes")], {
    cwd: root, encoding: "utf8",
  });
  if (globalExcludes.status !== 0) throw new Error(globalExcludes.stderr || "Could not set fixture global excludes");
  const localExcludePath = join(root, ".git/info/exclude");
  writeFileSync(localExcludePath, `${readFileSync(localExcludePath, "utf8")}public/local-excluded.txt\n`);
  expect(stackFingerprint(root)).toBe(withExternalIgnoreSource);

  write("public/tracked-source.txt", "changed tracked source");
  const withTrackedSource = stackFingerprint(root);
  expect(withTrackedSource).not.toBe(withExternalIgnoreSource);

  write("src/setup/client.mjs", "export const installer = 'changed source';");
  const withClientSource = stackFingerprint(root);
  expect(withClientSource).not.toBe(withTrackedSource);

  write("src/setup/ui.tsx", "export const page = 'changed source';");
  const withUiSource = stackFingerprint(root);
  expect(withUiSource).not.toBe(withClientSource);

  write("apps/pool/ui/style.css", "changed source styles");
  const withStyleSource = stackFingerprint(root);
  expect(withStyleSource).not.toBe(withUiSource);

  write("scripts/setup-build.ts", "build({ entryPoints: ['src/setup/client.mjs'] });");
  const withBuildSource = stackFingerprint(root);
  expect(withBuildSource).not.toBe(withStyleSource);

  write(".gitignore", `${readFileSync(join(root, ".gitignore"), "utf8")}\n# changed policy\n`);
  expect(stackFingerprint(root)).not.toBe(withBuildSource);
});

test("without a Git checkout, ignored-looking public assets are conservatively included", () => {
  const { root, write } = fixture();
  write(".gitignore", "public/setup/\n");
  write("alchemy.run.ts", 'new URL("./public/", import.meta.url);');
  const before = stackFingerprint(root);
  write("public/setup/main.js", "built setup bundle");
  expect(stackFingerprint(root)).not.toBe(before);
});

test("dependency checkout state is represented by its pin and patches", () => {
  const { root, write } = fixture();
  write("alchemy.run.ts", 'import "./.upstream/stack.ts"; new URL("./.upstream/", import.meta.url);');
  write("upstream.json", '{"commit":"first"}');
  const before = stackFingerprint(root);
  write(".upstream/stack.ts", 'new URL("./public/", import.meta.url);');
  write(".upstream/public/generated.txt", "platform-specific build output");
  expect(stackFingerprint(root)).toBe(before);
  write("upstream.json", '{"commit":"next"}');
  const next = stackFingerprint(root);
  expect(next).not.toBe(before);
  write("patches/change.patch", "changed deployment source");
  expect(stackFingerprint(root)).not.toBe(next);
});

test("workflow and command declarations participate in deployment drift", () => {
  const { root, write } = fixture();
  const before = stackFingerprint(root);
  write(".github/workflows/deploy.yml", "steps:\n  - run: npm run deploy\n");
  const workflow = stackFingerprint(root);
  expect(workflow).not.toBe(before);
  write("package.json", '{"scripts":{"deploy":"node scripts/deploy.ts"}}');
  expect(stackFingerprint(root)).not.toBe(workflow);
});
