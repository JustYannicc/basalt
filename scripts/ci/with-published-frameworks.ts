import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { PublishedAppFramework } from "../../.upstream/packages/sdk/src/contracts/worker-build.ts";
import { frameworkIdentity } from "../../.upstream/packages/sdk/src/implementation/framework-identity.ts";
import { generatedFrameworkReleases } from "../../.upstream/packages/sdk/src/implementation/basalt-qualified-framework-releases.ts";

const upstream = fileURLToPath(new URL("../../.upstream/", import.meta.url));
const [separator, command, ...args] = process.argv.slice(2);
assert.ok(separator === "--" && command, "Expected -- and a focused E2E command");
const lock = JSON.parse(readFileSync(join(upstream, "e2e/npm-packages.json"), "utf8"));
const fixtures = [];
for (const [version, release] of Object.entries(lock.packages.apps.versions)) {
  const pinned = Schema.decodeUnknownSync(Schema.Struct({ integrity: Schema.String }))(release);
  const archive = join(upstream, ".local/test-runtime/npm", `apps-${version}.tgz`);
  const bytes = readFileSync(archive);
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    pinned.integrity,
    `Published fixture apps@${version} differs from its locked archive`,
  );
  const runtime = Schema.decodeUnknownSync(Schema.fromJsonString(PublishedAppFramework))(
    execFileSync("tar", ["-xOf", archive, "package/runtime.json"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
  );
  assert.equal(runtime.version, version, "The archived release must name its locked version");
  fixtures.push({
    ...(await Effect.runPromise(frameworkIdentity({ version, modules: runtime.server }))),
    protocol: runtime.protocol,
    browserSha256: (
      await Effect.runPromise(frameworkIdentity({ version, modules: runtime.browser }))
    ).sha256,
    source: {
      origin: "basalt",
      revision: `synthetic-e2e:locked-npm:apps@${version}:${pinned.integrity}`,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  });
}

// This adapter fixture deliberately advertises current code as the retained protocol it exercises.
const localArchive = readFileSync(join(upstream, ".local/test-runtime/apps.tgz"));
const localRuntime = Schema.decodeUnknownSync(Schema.fromJsonString(PublishedAppFramework))(
  execFileSync(
    "tar",
    ["-xOf", join(upstream, ".local/test-runtime/apps.tgz"), "package/runtime.json"],
    {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  ),
);
const localIdentity = await Effect.runPromise(
  frameworkIdentity({ version: localRuntime.version, modules: localRuntime.server }),
);
assert.ok(
  generatedFrameworkReleases.some(
    (release) =>
      release.version === localIdentity.version &&
      release.sha256 === localIdentity.sha256 &&
      release.protocol === localRuntime.protocol,
  ),
  "The protocol adapter fixture must start from an approved current framework",
);
fixtures.push({
  ...localIdentity,
  version: "synthetic-e2e-protocol26",
  protocol: 26,
  browserSha256: (
    await Effect.runPromise(
      frameworkIdentity({ version: localRuntime.version, modules: localRuntime.browser }),
    )
  ).sha256,
  source: {
    origin: "basalt",
    revision: "synthetic-e2e:current-framework:protocol26-adapter",
    sha256: createHash("sha256").update(localArchive).digest("hex"),
  },
});

// Published npm fixtures are test inputs, never additions to the product's approved releases.
const registry = join(
  upstream,
  "packages/sdk/src/implementation/basalt-qualified-framework-releases.ts",
);
const original = readFileSync(registry, "utf8");
const injected = `export const generatedFrameworkReleases = ${JSON.stringify([
  ...generatedFrameworkReleases,
  ...fixtures,
])} as const;\n`;
writeFileSync(registry, injected);
let child: ReturnType<typeof spawn> | undefined;
let interrupted = false;
const interrupt = (signal: NodeJS.Signals) => {
  interrupted = true;
  child?.kill(signal);
};
const run = async (executable: string, arguments_: string[]) => {
  if (interrupted) return 1;
  const spawned = spawn(executable, arguments_, { cwd: upstream, stdio: "inherit" });
  child = spawned;
  try {
    return await new Promise<number>((resolve, reject) => {
      spawned.once("error", reject);
      spawned.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    if (child === spawned) child = undefined;
  }
};
process.on("SIGTERM", interrupt);
process.on("SIGINT", interrupt);
let assetsRestored = false;
try {
  // The SDK registry is part of the dashboard and workerd host build inputs.
  const prepared = await run("bun", ["run", "e2e:prepare"]);
  process.exitCode = prepared === 0 ? await run(command, args) : prepared;
} finally {
  try {
    const observed = (() => {
      try {
        return readFileSync(registry, "utf8");
      } catch {
        return undefined;
      }
    })();
    writeFileSync(registry, original);
    if (!interrupted) {
      const restored = await run("bun", ["run", "e2e:prepare"]);
      assetsRestored = restored === 0;
      if (!assetsRestored) process.exitCode = restored;
    }
    assert.equal(observed, injected, "The fixture registry changed outside its owner");
  } finally {
    // An interrupted build must never leave fixture approvals in reusable product assets.
    if (!assetsRestored)
      for (const output of [
        "apps/hosted/self-host/web/dist",
        "apps/local/web/dist",
        ".local/test-runtime/host.json",
        ".local/test-runtime/host.json.map",
      ])
        rmSync(join(upstream, output), { recursive: true, force: true });
    process.off("SIGTERM", interrupt);
    process.off("SIGINT", interrupt);
  }
}
