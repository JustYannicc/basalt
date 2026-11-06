import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { State } from "alchemy/State/State";
import { evalStack } from "alchemy/Stack";
import { Cause, Context, Effect, Exit } from "effect";
import { recoverStack } from "./recover-stack.ts";
import { readRecoveryManifest } from "./recovery.ts";
import { deployStack } from "./deploy-stack.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { BarrierRefusal } from "./manifest.ts";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !/^[a-f0-9]{40}$/.test(process.env.BASALT_RELEASE_CANDIDATE ?? "")
)
  throw new Error("Release barrier requires GitHub Actions and an immutable candidate");
if (process.env.ALCHEMY_STAGE !== "production")
  throw new Error("Release barrier requires the production stage");
const args = process.argv.slice(2);
if (args.length && (args.length !== 3 || args[0] !== "--recover"))
  throw new Error("Use --recover <manifest.json> <receipt.json>");
const recovery = args.length
  ? {
      manifest: JSON.parse(await readFile(resolve(args[1]!), "utf8")),
      receipt: JSON.parse(await readFile(resolve(args[2]!), "utf8")),
    }
  : undefined;
if (
  recovery &&
  readRecoveryManifest(recovery.manifest).candidate !== process.env.BASALT_RELEASE_CANDIDATE
)
  throw new Error("Recovery candidate does not match its frozen manifest");
process.chdir(fileURLToPath(new URL("../../.upstream/apps/hosted/cloud/", import.meta.url)));
const directory = fileURLToPath(new URL("../../.local/release-barrier/", import.meta.url));
await mkdir(directory, { recursive: true, mode: 0o700 });
const record = async (name: string, value: unknown) => {
  const path = resolve(directory, name);
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(`${path}.tmp`, path);
};
const result = await Effect.runPromiseExit(
  Effect.suspend(() =>
    Effect.promise(
      async () => (await import(new URL("../../alchemy.run.ts", import.meta.url).href)).default,
    ),
  ).pipe(
    Effect.flatMap((stack) =>
      evalStack(
        stack,
        (compiled) =>
          (recovery
            ? recoverStack(compiled, recovery.manifest, recovery.receipt, (value) =>
                record("recovery.json", value),
              )
            : deployStack(compiled, {
                candidate: process.env.BASALT_RELEASE_CANDIDATE!,
                record: (value) => record("receipt.json", value),
                manifest: (value) => record("manifest.json", value),
              })
          ).pipe(
            Effect.provideContext(compiled.services),
            Effect.provideService(State, Context.get(compiled.services, State)),
          ),
        { stage: "production" },
      ),
    ),
    withReleaseRuntime,
  ),
);
if (Exit.isFailure(result)) {
  const error = Cause.squash(result.cause);
  const failure =
    error instanceof BarrierRefusal
      ? { reason: error.reason, worker: error.worker }
      : { reason: "preparation-or-provider-failed" };
  await record("failure.json", failure);
  console.error(
    `Release barrier refused: ${failure.reason}${failure.worker ? ` (${failure.worker})` : ""}. See release-barrier receipts.`,
  );
  process.exitCode = 1;
}
