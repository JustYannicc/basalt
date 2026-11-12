import { createHash } from "node:crypto";
import { SafetyGateError } from "./contracts.ts";
import {
  cloudflareResult,
  encodePathSegment,
  record,
  stringField,
  withBearer,
  type Fetcher,
} from "./http.ts";
import type { CloudflareCredentials } from "./cloudflare.ts";

const capabilityLabel = "io.signalbox.pool.oauth-completion-receipts";
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const manifestTypes =
  "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json";

async function boundedJson(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  expectedDigest?: string,
  acceptedStatuses: readonly number[] = [200],
) {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SafetyGateError("Pool image metadata request failed");
  }
  if (!acceptedStatuses.includes(response.status) || !response.body) {
    await response.body?.cancel();
    throw new SafetyGateError(`Pool image metadata request returned HTTP ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new SafetyGateError("Pool image metadata exceeds its size bound");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = Buffer.concat(chunks);
  if (
    expectedDigest &&
    `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expectedDigest
  )
    throw new SafetyGateError("Pool image metadata bytes differ from the published digest");
  try {
    return record(JSON.parse(bytes.toString("utf8")), "Pool image metadata");
  } catch {
    throw new SafetyGateError("Pool image metadata is not a JSON object");
  }
}

function descriptorDigest(value: unknown) {
  const digest = stringField(
    record(value, "Pool image descriptor").digest,
    "Pool image descriptor digest",
  );
  if (!digestPattern.test(digest))
    throw new SafetyGateError("Pool image descriptor digest is invalid");
  return digest;
}

export async function withPoolRegistryPull<T>(
  imageRef: string,
  expectedDigest: string,
  credentials: CloudflareCredentials,
  consume: (access: { username: string; password: string; repository: string }) => Promise<T>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  // Credentials may only reach this account's managed registry, through immutable references.
  const prefix = `registry.cloudflare.com/${credentials.accountId}/`;
  if (
    !digestPattern.test(expectedDigest) ||
    !imageRef.startsWith(prefix) ||
    !imageRef.endsWith(`@${expectedDigest}`)
  )
    throw new SafetyGateError("Pool image reference is outside its account or publication digest");
  const repository = imageRef.slice(
    "registry.cloudflare.com/".length,
    -`@${expectedDigest}`.length,
  );
  if (!repository.split("/").every((part) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part)))
    throw new SafetyGateError("Pool image repository is invalid");
  const issued = record(
    cloudflareResult(
      await boundedJson(
        fetcher,
        `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(credentials.accountId)}/containers/registries/registry.cloudflare.com/credentials`,
        {
          method: "POST",
          headers: withBearer(credentials.apiToken, { "Content-Type": "application/json" }),
          body: JSON.stringify({ permissions: ["pull"], expiration_minutes: 60 }),
        },
        undefined,
        [200, 201],
      ),
      "pool registry credentials",
    ).result,
    "Pool registry credentials",
  );
  const username = stringField(issued.username ?? issued.user, "Pool registry username");
  const password = stringField(issued.password, "Pool registry password");
  return consume({ username, password, repository });
}

export async function inspectPoolImage(
  imageRef: string,
  expectedDigest: string,
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
) {
  return withPoolRegistryPull(
    imageRef,
    expectedDigest,
    credentials,
    async ({ username, password, repository }) => {
      const headers = {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
        Accept: manifestTypes,
      };
      const base = `https://registry.cloudflare.com/v2/${repository.split("/").map(encodePathSegment).join("/")}`;
      const manifest = (digest: string) =>
        boundedJson(fetcher, `${base}/manifests/${digest}`, { method: "GET", headers }, digest);
      let publication = await manifest(expectedDigest);
      if (Array.isArray(publication.manifests)) {
        const matches = publication.manifests
          .map((value) => record(value, "Pool image index entry"))
          .filter((entry) => {
            const platform = record(entry.platform, "Pool image index platform");
            return platform.os === "linux" && platform.architecture === "amd64";
          });
        if (matches.length !== 1)
          throw new SafetyGateError("Pool image index has no unique linux/amd64 image");
        publication = await manifest(descriptorDigest(matches[0]));
      }
      const configDigest = descriptorDigest(publication.config);
      const config = await boundedJson(
        fetcher,
        `${base}/blobs/${configDigest}`,
        { method: "GET", headers },
        configDigest,
      );
      const platform = `${stringField(config.os, "Pool image OS")}/${stringField(config.architecture, "Pool image architecture")}`;
      const label = record(
        record(config.config, "Pool image configuration").Labels,
        "Pool image labels",
      )[capabilityLabel];
      if (platform !== "linux/amd64" || label !== "1")
        throw new SafetyGateError(
          "Pool image platform or OAuth completion capability label is missing",
        );
      return { digest: expectedDigest, configDigest, platform, capabilityLabel: label };
    },
    fetcher,
  );
}
