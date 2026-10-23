import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { pipelineDependencies } from "./pipeline.ts";
import type { Module, OutsideService } from "./source.ts";
const build: Module = { id: "build", code: "containers", bindings: [], libraries: [] };
const ci: Module = { ...build, code: ".github/workflows" };
function scan(files: Record<string, string>, services: OutsideService[] = []) {
  const root = mkdtempSync(join(tmpdir(), "pipeline-source-"));
  try {
    for (const [file, text] of Object.entries(files)) { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); }
    return pipelineDependencies(root, [build, ci], services);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
test("container registries, workflow actions and package installs require caller edges", () => {
  const files = { "containers/pool/Dockerfile": "FROM python:3 AS builder\nRUN apk add ca-certificates\nFROM builder\n", ".github/workflows/ci.yml": "jobs:\n  check:\n    container: postgres:17\n    steps:\n      - uses: actions/checkout@v4\n      - run: bun install\n" };
  expect(scan(files).errors).toHaveLength(5);
  const result = scan(files, [{ id: "registry", hosts: ["registry-1.docker.io"], sdks: [] }, { id: "release", hosts: ["github.com"], sdks: [] }, { id: "packages", hosts: [], sdks: ["package:npm", "package:apk"] }]);
  expect(result.errors).toEqual([]);
  expect(new Set(result.dependencies.map(edge => edge.target))).toEqual(new Set(["registry", "release", "packages"]));
});
test("new literal hosts and SDKs in Docker and CI sources fail", () => {
  const result = scan({ "containers/pool/Dockerfile": "FROM scratch\nRUN curl https://new.example.invalid/file\n", ".github/workflows/ci.yml": "steps:\n  - run: node -e 'import(\"unknown-sdk\")'\n" });
  expect(result.errors.join("\n")).toContain("Unmodelled outside host: new.example.invalid");
  expect(result.errors.join("\n")).toContain("Unmodelled SDK or library: unknown-sdk");
});
test("dynamic downloads and images fail instead of assuming a destination", () => {
  const result = scan({ "containers/pool/Dockerfile": "FROM ${REGISTRY}/image\nRUN curl $OUTSIDE\n", ".github/workflows/ci.yml": "steps:\n  - uses: ${{ inputs.action }}\n" });
  expect(result.errors).toHaveLength(3);
});
