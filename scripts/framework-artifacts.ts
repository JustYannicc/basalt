import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { refuseFramework } from "./deploy-safety/framework-refusal.ts";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** The publication receipt binds the files the compiler receives before activation. */
export function readFrameworkArtifacts(root: string) {
  const runtimePath = join(root, ".upstream/packages/apps/dist/runtime.json");
  const packagePath = join(root, ".upstream/.local/basalt-framework/framework.json");
  const read = (path: string) => {
    try {
      return readFileSync(path);
    } catch {
      return refuseFramework("Missing framework publication artifact", [
        { resource: path, property: "file", expected: "readable bytes", observed: "unavailable" },
      ]);
    }
  };
  const runtime = read(runtimePath);
  const packaged = read(packagePath);
  let files: unknown;
  try {
    files = JSON.parse(packaged.toString("utf8"));
  } catch {
    refuseFramework("Malformed framework publication artifact", [
      {
        resource: packagePath,
        property: "format",
        expected: "JSON file map",
        observed: "malformed",
      },
    ]);
  }
  const packedRuntime =
    files && typeof files === "object" && "runtime.json" in files
      ? files["runtime.json"]
      : undefined;
  if (typeof packedRuntime !== "string" || !Buffer.from(packedRuntime).equals(runtime))
    refuseFramework("Framework publication contains different runtime bytes", [
      {
        resource: packagePath,
        property: "runtime.json.sha256",
        expected: digest(runtime),
        observed: typeof packedRuntime === "string" ? digest(packedRuntime) : "missing string",
      },
    ]);
  return { runtimeJsonSha256: digest(runtime), frameworkJsonSha256: digest(packaged) };
}
