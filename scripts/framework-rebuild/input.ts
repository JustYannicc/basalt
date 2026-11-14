import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const toolchains = {
  "ubuntu-24.04-bun-1.4.2": { runner: "ubuntu-24.04", bun: "1.4.2", checkout: "candidate" },
  "ubuntu-26.04-bun-1.4.2": { runner: "ubuntu-26.04", bun: "1.4.2", checkout: "candidate" },
  "ubuntu-24.04-bun-1.4.4": { runner: "ubuntu-24.04", bun: "1.4.4", checkout: "candidate" },
  "ubuntu-24.04-bun-1.4.4-workspace": {
    runner: "ubuntu-24.04",
    bun: "1.4.4",
    checkout: "workspace",
  },
} as const;

export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export function rebuildInput(env: NodeJS.ProcessEnv) {
  const commit = env.REBUILD_COMMIT ?? "";
  const toolchain = env.REBUILD_TOOLCHAIN ?? "";
  const uuid = env.REBUILD_GENERATION_UUID ?? "";
  const key = env.REBUILD_DEPENDENCY_KEY ?? "";
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("commit must be a full lowercase Git SHA");
  if (!Object.hasOwn(toolchains, toolchain)) throw new Error("unsupported logged toolchain");
  if (uuid && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(uuid))
    throw new Error("generation UUID must be a logged UUID v4");
  if (key && !/^[a-f0-9]{64}$/.test(key)) throw new Error("dependency key must be a SHA-256");
  if (Boolean(uuid) !== Boolean(key))
    throw new Error("generation UUID and dependency key must be supplied together");
  const profile = toolchains[toolchain as keyof typeof toolchains];
  return { commit, toolchain, uuid, key, ...profile };
}

export type RebuildInput = ReturnType<typeof rebuildInput>;

export function frameworkPreparation(source: string) {
  const boundaries = [
    'await installUpstreamDependencies(upstream, pin.commit, process.argv.includes("--cache-hit-only"));',
    "await installUpstreamDependencies(upstream, pin.commit);",
    'run("bun", ["install", "--frozen-lockfile"], upstream);',
  ].filter((boundary) => source.includes(boundary));
  if (boundaries.length !== 1 || source.split(boundaries[0]!).length !== 2)
    throw new Error("unsupported historical dependency preparation boundary");
  const boundary = boundaries[0]!;
  // Framework packaging needs the prepared source and dependencies, before unrelated app and Worker builds.
  return source.slice(0, source.indexOf(boundary) + boundary.length) + "\n";
}

export function pinnedPreparation(source: string, input: RebuildInput) {
  const entry = 'const entry = join(upstreamCache(), "prepared", pin, key);';
  const id = "const id = randomUUID();";
  if (
    !input.uuid ||
    !input.key ||
    source.split(entry).length !== 2 ||
    source.split(id).length !== 2
  )
    throw new Error("unsupported historical generation preparation");
  // Check the historical calculation before its cache lock or installer. Never replace the calculated key.
  const guard =
    `if (key !== ${JSON.stringify(input.key)}) {\n` +
    `process.stderr.write("FRAMEWORK_REBUILD_KEY_MISMATCH expected=${input.key} actual=" + key + "\\n");\n` +
    'throw new Error("Historical dependency key differs");\n}';
  return source
    .replace(entry, `${guard}\n  ${entry}`)
    .replace(id, `const id = ${JSON.stringify(input.uuid)};`);
}

export function pinPreparation(root: string, input: RebuildInput) {
  const file = join(root, "scripts/upstream-dependencies.ts");
  const entry = join(root, "scripts/prepare-upstream.ts");
  const originalEntry = readFileSync(entry, "utf8");
  const frameworkEntry = frameworkPreparation(originalEntry);
  if (!existsSync(file)) {
    if (input.uuid || input.key)
      throw new Error("direct-install source has no generation UUID or key");
    writeFileSync(entry, frameworkEntry);
    return { layout: "direct" as const, restore: () => writeFileSync(entry, originalEntry) };
  }
  const original = readFileSync(file, "utf8");
  writeFileSync(file, pinnedPreparation(original, input));
  writeFileSync(entry, frameworkEntry);
  return {
    layout: "generation" as const,
    restore: () => {
      writeFileSync(file, original);
      writeFileSync(entry, originalEntry);
    },
  };
}

export function verifyGeneration(root: string, input: RebuildInput, home: string, pin: string) {
  const file = join(root, ".upstream/.basalt-dependencies.json");
  if (!input.uuid) {
    if (existsSync(file))
      throw new Error("direct-install source unexpectedly selected a generation");
    return;
  }
  const record: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    !record ||
    typeof record !== "object" ||
    !("key" in record) ||
    !("store" in record) ||
    record.key !== input.key ||
    typeof record.store !== "string"
  )
    throw new Error("prepared dependency identity differs");
  const expected = join(
    home,
    ".cache/basalt/upstream/prepared",
    pin,
    input.key,
    "generations",
    input.uuid,
  );
  if (realpathSync(record.store) !== expected)
    throw new Error("prepared generation location differs");
}
