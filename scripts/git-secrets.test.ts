import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkGitSecrets, gitSecretReport } from "./git-secrets.ts";

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "basalt-git-secrets-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const write = (file: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-m",
      "fixture",
    );
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q");
  write("README.md", "fixture\n");
  const base = commit();
  return {
    root,
    git,
    write,
    commit,
    base,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
};

test("staged files refuse secret values without including them in the diagnostic", () => {
  const f = fixture();
  try {
    const value = "synthetic-gate-token-do-not-print";
    f.write("config.json", JSON.stringify({ token: value }));
    f.git("add", "config.json");
    const findings = checkGitSecrets({
      ...f,
      environment: { FIXTURE_API_TOKEN: value, PUBLIC_LABEL: "fixture" },
    });
    assert.deepEqual(findings, [
      {
        file: "config.json",
        source: "staged",
        reason: "literal value from secret-named environment variable FIXTURE_API_TOKEN",
      },
    ]);
    assert.ok(!gitSecretReport(findings).includes(value));
    assert.match(gitSecretReport(findings), /config.json.*FIXTURE_API_TOKEN.*staged/);
  } finally {
    f.close();
  }
});

test("a new commit that exposed a value still fails after a later commit removes it", () => {
  const f = fixture();
  try {
    const value = "synthetic-intermediate-password";
    f.write("config.txt", value);
    const leaked = f.commit();
    f.write("config.txt", "removed\n");
    f.commit();
    const findings = checkGitSecrets({ ...f, environment: { SERVICE_PASSWORD: value } });
    assert.deepEqual(findings, [
      {
        file: "config.txt",
        source: `commit ${leaked.slice(0, 12)}`,
        reason: "literal value from secret-named environment variable SERVICE_PASSWORD",
      },
    ]);
  } finally {
    f.close();
  }
});

test("generated measurement scripts fail when staged directly or inside a committed carry", () => {
  const f = fixture();
  try {
    const path = "apps/hosted/cloud/scripts/basalt-worker-sizes.ts";
    f.write(path, "export {};\n");
    f.git("add", path);
    assert.match(
      gitSecretReport(checkGitSecrets({ ...f, environment: {} })),
      /generated Worker measurement file \(staged\)/,
    );
    f.git("reset", "--", path);
    rmSync(join(f.root, path));
    f.write("patches/fixture.patch", `diff --git a/${path} b/${path}\nnew file mode 100644\n`);
    const carried = f.commit();
    assert.deepEqual(checkGitSecrets({ ...f, environment: {} }), [
      {
        file: "patches/fixture.patch",
        source: `commit ${carried.slice(0, 12)}`,
        reason: "carried generated Worker measurement file",
      },
    ]);
  } finally {
    f.close();
  }
});

test("JSON escaped values and binary files are checked, including short nonempty secrets", () => {
  const f = fixture();
  try {
    f.write("config.json", JSON.stringify({ privateKey: "fixture\nmultiline" }));
    f.write("asset.bin", Buffer.from([0, 65, 66, 67, 0]));
    f.git("add", "config.json", "asset.bin");
    const findings = checkGitSecrets({
      ...f,
      environment: { PRIVATE_KEY: "fixture\nmultiline", OTHER_SECRET: "ABC" },
    });
    assert.deepEqual(findings.map(({ file }) => file).sort(), ["asset.bin", "config.json"]);
  } finally {
    f.close();
  }
});

test("unstaged and ignored local output are outside staged and new-commit contents", () => {
  const f = fixture();
  try {
    f.write(".gitignore", ".local/\n");
    f.commit();
    const value = "synthetic-unstaged-token";
    f.write("config.txt", value);
    f.write("apps/hosted/cloud/.local/basalt-worker-sizes.ts", value);
    assert.equal(
      f.git("check-ignore", "apps/hosted/cloud/.local/basalt-worker-sizes.ts").trim(),
      "apps/hosted/cloud/.local/basalt-worker-sizes.ts",
    );
    assert.deepEqual(checkGitSecrets({ ...f, environment: { API_TOKEN: value } }), []);
  } finally {
    f.close();
  }
});
