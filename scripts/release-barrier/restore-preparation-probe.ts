import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Schema } from "effect";
import { AdoptionSource } from "./journal-restore-contract.ts";
import { loadAdoptionProof } from "./journal-restore-proof.ts";
import { ObservationStoreManifest } from "./observation-store-contract.ts";
import { observationStoreEnvelope } from "./observation-store-envelope.ts";
import { operationFailure } from "./operation-failure.ts";
import { reportRefusal } from "./refusal-report.ts";

const Input = Schema.Struct({ source: AdoptionSource, adoption: ObservationStoreManifest });

/** The real artifact-loading path, with no State services or Cloudflare credentials in scope. */
export async function probeRestorePreparation(
  env: NodeJS.ProcessEnv,
  nativeFetch = globalThis.fetch,
) {
  const input = Schema.decodeUnknownSync(Input, { onExcessProperty: "error" })(
    JSON.parse(env.BASALT_RESTORE_PREPARATION_PROBE_INPUT ?? "null"),
  );
  const base = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}`;
  const paths = new Set([
    `${base}/actions/runs/${input.source.runId}/attempts/${input.source.attempt}`,
    `${base}/actions/artifacts/${input.source.artifactId}`,
    `${base}/actions/artifacts/${input.source.artifactId}/zip`,
  ]);
  const signed = new Set<string>();
  const calls = { github: 0, archive: 0, cloudflare: 0, stateOrOther: 0 };
  const guardedFetch: typeof fetch = async (value, init) => {
    const request = new Request(value, init);
    const url = new URL(request.url);
    if (url.hostname.replace(/\.+$/u, "") === "api.cloudflare.com") {
      calls.cloudflare++;
      throw new Error("Preparation probe denied Cloudflare access");
    }
    const github = paths.has(url.href);
    const archive = signed.has(url.href) && !request.headers.has("authorization");
    if (request.method !== "GET" || (!github && !archive)) {
      calls.stateOrOther++;
      throw new Error("Preparation probe denied State or unrelated access");
    }
    calls[github ? "github" : "archive"]++;
    const response = await nativeFetch(request);
    if (github && url.pathname.endsWith("/zip") && response.status === 302) {
      const location = response.headers.get("location");
      if (location && new URL(location).protocol === "https:") signed.add(location);
    }
    return response;
  };
  const envelope = observationStoreEnvelope(
    input.adoption.accountId,
    async () => {
      calls.cloudflare++;
      throw new Error("Preparation probe denied Cloudflare auth");
    },
    guardedFetch,
  );
  let preparation: "PASS" | "FAIL" = "FAIL";
  const receipt = () => ({
    format: "pool-restore-preparation-probe-v1",
    preparation,
    candidate: env.GITHUB_SHA,
    archiveVerified: preparation === "PASS",
    receiptVerified: preparation === "PASS",
    calls,
    networkEnvelope: envelope.receipt(),
  });
  const previousFetch = globalThis.fetch;
  globalThis.fetch = envelope.fetch;
  try {
    await loadAdoptionProof(input.source, input.adoption, env, envelope.fetch);
    envelope.assertClean();
    if (calls.cloudflare || calls.stateOrOther || calls.github !== 3 || calls.archive !== 1)
      throw new Error("Preparation probe did not stay within its read-only request scope");
    preparation = "PASS";
    return receipt();
  } finally {
    globalThis.fetch = previousFetch;
    const path = resolve(
      env.BASALT_RESTORE_PREPARATION_PROBE_OUTPUT ?? ".local/restore-preparation-probe.json",
    );
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(receipt()) + "\n", { mode: 0o600 });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await probeRestorePreparation(process.env)));
  } catch (error) {
    const failure = operationFailure(error, "(restore-preparation)", "release-stack");
    await reportRefusal({
      reason: failure.reason,
      operation: failure.operation,
      provider: failure.provider,
    });
    process.exitCode = 1;
  }
}
