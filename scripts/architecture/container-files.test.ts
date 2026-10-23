import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, expect, test } from "vitest";
import { containerInputs, containerRuntimeFiles } from "./container-files.ts";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "architecture-container-"));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}
const dockerfile = `FROM python:3 AS fetch
COPY releases.json fetch.py ./
FROM python:3
COPY --from=fetch /out/binary /bin/binary
COPY --chown=pool:pool \\
  ["runtime.py", "package", "/app/"]
`;

test("build inputs include every stage while runtime ownership follows the final stage", () => {
  const root = fixture({ Dockerfile: dockerfile, "releases.json": "{}", "fetch.py": "build", "runtime.py": "run", "package/__init__.py": "package", "unused.py": "unused" });
  expect(containerInputs(root).map(file => relative(root, file))).toEqual([
    "Dockerfile", "fetch.py", "package/__init__.py", "releases.json", "runtime.py",
  ]);
  expect(containerRuntimeFiles(root).map(file => relative(root, file))).toEqual(["package/__init__.py", "runtime.py"]);
});

test("every selected build/config/runtime input changes an input-based digest", () => {
  const root = fixture({ Dockerfile: dockerfile, "releases.json": "{}", "fetch.py": "build", "runtime.py": "run", "package/__init__.py": "package" });
  const digest = () => {
    const hash = createHash("sha256");
    for (const file of containerInputs(root)) hash.update(relative(root, file)).update(readFileSync(file));
    return hash.digest("hex");
  };
  for (const file of containerInputs(root)) {
    const previous = digest();
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text + (file.endsWith("Dockerfile") ? "\n# changed\n" : "\nchanged"));
    expect(digest(), relative(root, file)).not.toBe(previous);
  }
});

test("a final stage based on an earlier stage inherits its own source inputs", () => {
  const root = fixture({ Dockerfile: 'FROM python:3 AS base\nCOPY "app.py" /app/\nFROM base AS runtime\nCOPY extra.py /app/\n', "app.py": "", "extra.py": "" });
  expect(containerRuntimeFiles(root).map(file => relative(root, file))).toEqual(["app.py", "extra.py"]);
});

test.each(["$SOURCE", "${SOURCE}", "*.py", "../outside.py", "/absolute.py", "missing.py"])("unresolvable context source %s fails closed", source => {
  const root = fixture({ Dockerfile: `FROM python:3\nCOPY ${source} /app/\n` });
  expect(() => containerInputs(root)).toThrow(/context path/);
});

test("unsupported context filtering and ADD report errors", () => {
  const root = fixture({ Dockerfile: "FROM python:3\nCOPY app.py /app/\n", "app.py": "", ".dockerignore": "app.py\n" });
  expect(() => containerRuntimeFiles(root)).toThrow(/ignore rules/);
  writeFileSync(join(root, "Dockerfile"), "FROM python:3\nADD app.py /app/\n");
  expect(() => containerInputs(root)).toThrow(/Unsupported Docker ADD/);
});

test("symlinks cannot read source outside the context", () => {
  const root = fixture({ Dockerfile: "FROM python:3\nCOPY linked.py /app/\n" });
  const outside = fixture({ "outside.py": "" });
  symlinkSync(join(outside, "outside.py"), join(root, "linked.py"));
  expect(() => containerInputs(root)).toThrow(/escapes context/);
});
