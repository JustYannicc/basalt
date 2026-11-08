import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Schema } from "effect";
import { encodeState } from "alchemy/State/StateEncoding";
import type { PersistedState } from "alchemy/State/State";
import { BarrierRefusal } from "./manifest.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { readForwardPacket } from "./forward-model.ts";

export async function forwardSeed(saved: PersistedState | undefined, key: string) {
  const settings = Schema.decodeUnknownSync(
    Schema.Struct({
      runId: Schema.String,
      candidate: Schema.String,
      manifest: Schema.String,
      approvedBefore: Schema.NullOr(Schema.String),
      approvedAfter: Schema.NullOr(Schema.String),
    }),
  )(JSON.parse(await readFile(new URL("./forward-seed.json", import.meta.url), "utf8")));
  if (process.env.GITHUB_ACTIONS !== "true" || !/^\d+$/u.test(settings.runId))
    throw new BarrierRefusal("forward-seed-ci-only");
  const directory = resolve(new URL("../../.local/forward-seed/", import.meta.url).pathname);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  execFileSync(
    "gh",
    [
      "run",
      "download",
      settings.runId,
      "--repo",
      "JustYannicc/basalt",
      "--name",
      "release-barrier",
      "--dir",
      directory,
    ],
    { stdio: "pipe" },
  );
  const files = await readdir(directory, { recursive: true });
  const manifests = files.filter(
    (file) => file.endsWith("manifest.json") && !file.endsWith("desired-manifest.json"),
  );
  if (manifests.length !== 1) throw new BarrierRefusal("forward-seed-artifact-coverage");
  const root = resolve(directory, manifests[0]!, "..");
  const json = async (name: string) => JSON.parse(await readFile(resolve(root, name), "utf8"));
  const packet = readForwardPacket({
    schemaVersion: 1,
    manifest: await json("manifest.json"),
    receipt: await json("receipt.json"),
    frozen: openRecovery(
      await json("container-recovery.sealed.json"),
      key,
      settings.candidate,
      settings.manifest,
    ),
    nativeBefore: encodeState(saved),
  });
  if (
    packet.manifest.candidate !== settings.candidate ||
    packet.receipt.manifest !== settings.manifest
  )
    throw new BarrierRefusal("forward-seed-identity");
  return { packet, approvedBefore: settings.approvedBefore, approvedAfter: settings.approvedAfter };
}
