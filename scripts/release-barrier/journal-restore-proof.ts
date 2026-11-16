import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { canonical, digest } from "./manifest.ts";
import { observationStoreDigest } from "./observation-store-contract.ts";
import {
  AdoptionSource,
  StoreAdoptionReceipt,
  type AdoptionProof,
} from "./journal-restore-contract.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Envelope = Schema.Struct({
  format: Schema.Literal("pool-observation-store-network-envelope-v1"),
  authPreviewRequests: Schema.Struct({
    createSubdomainEdgePreviewSession: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    createScriptEdgePreview: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  authPreviewPosts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  otherCloudflareMutations: Schema.Literal(0),
  blockedMutations: Schema.Literal(0),
});
const Receipt = Schema.Struct({
  disposition: Schema.Literal("apply"),
  manifest: hash,
  receipt: StoreAdoptionReceipt,
  networkEnvelope: Envelope,
});

export function verifyAdoptionReceipt(bytes: Uint8Array, proof: Omit<AdoptionProof, "receipt">) {
  sameProvisioningValue("restore.source.receipt", proof.source.receiptDigest, digest(bytes));
  const value = Schema.decodeUnknownSync(Receipt, { onExcessProperty: "error" })(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  sameProvisioningValue(
    "restore.source.operation",
    digest(canonical({ kind: "observation-store", manifest: proof.adoption })),
    value.manifest,
  );
  sameProvisioningValue(
    "restore.source.manifest",
    observationStoreDigest(proof.adoption),
    value.receipt.manifest,
  );
  const counts = value.networkEnvelope.authPreviewRequests;
  if (
    counts.createSubdomainEdgePreviewSession + counts.createScriptEdgePreview > 8 ||
    value.networkEnvelope.authPreviewPosts !== counts.createScriptEdgePreview
  )
    throw new Error("Adoption receipt exceeds its accepted network envelope");
  return { ...proof, receipt: value.receipt };
}

/** Read the immutable run/artifact, rather than trusting a run number supplied beside a receipt. */
export async function loadAdoptionProof(
  source: typeof AdoptionSource.Type,
  adoption: AdoptionProof["adoption"],
  env: NodeJS.ProcessEnv,
  fetcher = globalThis.fetch,
) {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(env.GITHUB_REPOSITORY ?? "") || !env.GITHUB_TOKEN)
    throw new Error("Restore requires the workflow's repository artifact reader");
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  const signal = AbortSignal.timeout(30_000);
  const get = async (path: string) => {
    const response = await fetcher(base + path, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal,
    });
    if (response.status !== 200) throw new Error("Reviewed adoption artifact metadata unavailable");
    return response.json();
  };
  const run = Schema.decodeUnknownSync(
    Schema.Struct({
      id: Schema.Number,
      run_attempt: Schema.Number,
      head_sha: Schema.String,
      conclusion: Schema.Literal("success"),
      path: Schema.String,
    }),
  )(await get(`/actions/runs/${source.runId}/attempts/${source.attempt}`));
  sameProvisioningValue(
    "restore.source.run",
    {
      id: source.runId,
      attempt: source.attempt,
      candidate: adoption.candidate,
      path: ".github/workflows/pool-runtime-provision.yml",
    },
    { id: run.id, attempt: run.run_attempt, candidate: run.head_sha, path: run.path },
  );
  const artifact = Schema.decodeUnknownSync(
    Schema.Struct({
      id: Schema.Number,
      name: Schema.String,
      digest: Schema.String,
      expired: Schema.Literal(false),
      workflow_run: Schema.Struct({ id: Schema.Number, head_sha: Schema.String }),
    }),
  )(await get(`/actions/artifacts/${source.artifactId}`));
  sameProvisioningValue(
    "restore.source.artifact",
    {
      id: source.artifactId,
      name: `pool-provisioning-${source.runId}`,
      digest: `sha256:${source.archiveDigest}`,
      expired: false,
      workflow_run: { id: source.runId, head_sha: adoption.candidate },
    },
    artifact,
  );
  const redirect = await fetcher(`${base}/actions/artifacts/${source.artifactId}/zip`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}` },
    redirect: "manual",
    signal,
  });
  const location = redirect.headers.get("location");
  if (redirect.status !== 302 || !location || new URL(location).protocol !== "https:")
    throw new Error("Reviewed adoption archive unavailable");
  const response = await fetcher(location, { redirect: "error", signal });
  if (response.status !== 200) throw new Error("Reviewed adoption archive unavailable");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Reviewed adoption archive exceeds limit");
  sameProvisioningValue("restore.source.archive", source.archiveDigest, digest(bytes));
  const directory = await mkdtemp(join(tmpdir(), "adoption-receipt-"));
  try {
    const path = join(directory, "receipt.zip");
    await writeFile(path, bytes, { mode: 0o600 });
    const names = execFileSync("unzip", ["-Z1", path], { encoding: "utf8", maxBuffer: 4096 })
      .trim()
      .split("\n")
      .sort();
    sameProvisioningValue(
      "restore.source.archive.files",
      ["network-envelope.json", "network-requests.jsonl", "receipt.json"],
      names,
    );
    const receipt = execFileSync("unzip", ["-p", path, "receipt.json"], { maxBuffer: 256 * 1024 });
    return verifyAdoptionReceipt(receipt, { source, adoption });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
