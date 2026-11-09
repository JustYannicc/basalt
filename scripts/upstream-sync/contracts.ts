import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./snapshot.ts";

const contractPaths = [
  "packages/sdk/src/implementation/storage-current.ts",
  "packages/sdk/src/implementation/storage-migrations.ts",
  "packages/sdk/src/implementation/storage.ts",
  "packages/sdk/src/implementation/app-protocols.ts",
  "packages/apps/package.json",
  "packages/apps/src/contracts/protocol-version.ts",
  "packages/apps/src/contracts/host.ts",
  "apps/hosted/cloud/src/implementation/migrations.ts",
  "apps/hosted/server/src/implementation/migrations.ts",
  "apps/hosted/self-host/src/implementation/workerd/storage-migration.ts",
];

export function retainContractSources(root: string, output: string) {
  const files = contractPaths.map((path) => {
    const file = join(root, path);
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile())
      return { path, status: "missing" as const };
    const content = readFileSync(file);
    const destination = join(output, "contracts", path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, { flag: "wx" });
    return { path, status: "retained" as const, sha256: sha256(content) };
  });
  const observations = files.flatMap((file) => {
    if (file.status !== "retained") return [];
    const lines = readFileSync(join(root, file.path), "utf8").split("\n");
    return lines.flatMap((text, index) => {
      const version = /\bversion\s*:\s*"([^"]+)"/.exec(text);
      const step = /^\s*"(\d+_[a-z_]+)"\s*:/.exec(text);
      const protocol = /^export const (\w*Protocol|frameworkProtocol) = (.+);$/.exec(text);
      return version || step || protocol
        ? [{ path: file.path, line: index + 1, source: text.trim() }]
        : [];
    });
  });
  const result = {
    scope: "Static source declarations. These are not live journal rows or compatibility proof.",
    files,
    observations,
  };
  writeFileSync(join(output, "contracts.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  return result;
}
