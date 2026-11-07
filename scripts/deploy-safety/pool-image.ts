import { SafetyGateError } from "./contracts.ts";
import type { CloudflareCredentials } from "./cloudflare.ts";
import {
  cloudflareResult,
  encodePathSegment,
  record,
  requestJson,
  stringField,
  withBearer,
  type Fetcher,
} from "./http.ts";
import { waitForPoolStatus } from "../pool-readiness.ts";

class PoolImagePending extends SafetyGateError {}

export function poolImageReceipt(value: unknown, candidate: string) {
  const receipt = record(value, "Pool image publication receipt");
  if (
    !/^[a-f0-9]{40}$/.test(candidate) ||
    receipt.candidate !== candidate ||
    receipt.platform !== "linux/amd64" ||
    receipt.capabilityLabel !== "1"
  )
    throw new SafetyGateError(
      "Pool image receipt does not identify this candidate and runtime capability",
    );
  const applicationId = stringField(receipt.applicationId, "Pool application id");
  const accountId = stringField(receipt.accountId, "Pool account id");
  const workerName = stringField(receipt.workerName, "Pool Worker name");
  const inputHash = stringField(receipt.inputHash, "Pool input hash");
  if (!/^[a-f0-9]{16}$/.test(inputHash))
    throw new SafetyGateError("Pool image input hash is invalid");
  const digest = stringField(receipt.digest, "Pool publication digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(digest))
    throw new SafetyGateError("Pool publication digest is invalid");
  const configDigest = stringField(receipt.configDigest, "Pool image config digest");
  if (!/^sha256:[a-f0-9]{64}$/.test(configDigest))
    throw new SafetyGateError("Pool image config digest is invalid");
  return {
    candidate,
    platform: "linux/amd64",
    capabilityLabel: "1",
    configDigest,
    applicationId,
    accountId,
    workerName,
    inputHash,
    digest,
  };
}

export async function assertPoolImage(
  value: unknown,
  candidate: string,
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
) {
  const receipt = poolImageReceipt(value, candidate);
  return { ...receipt, ...(await assertImages(receipt, credentials, fetcher, receipt)) };
}

export interface ContainerImageTarget {
  applicationId: string;
  accountId: string;
  digest: string;
}

/** Recovery must prove old instances before it can restore the old Worker and its input hash. */
export function assertContainerImage(
  target: ContainerImageTarget,
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
) {
  if (!target.applicationId || !target.accountId || !/^sha256:[a-f0-9]{64}$/.test(target.digest))
    throw new SafetyGateError("Container image recovery target is invalid");
  return assertImages(target, credentials, fetcher);
}

async function assertImages(
  receipt: ContainerImageTarget,
  credentials: CloudflareCredentials,
  fetcher: Fetcher,
  worker?: { workerName: string; inputHash: string },
) {
  if (receipt.accountId !== credentials.accountId)
    throw new SafetyGateError("Pool image receipt belongs to another account");
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(credentials.accountId)}/containers/applications/${encodePathSegment(receipt.applicationId)}`;
  const get = async (url: string, label: string) =>
    cloudflareResult(
      (
        await requestJson(fetcher, "Cloudflare", url, {
          method: "GET",
          headers: withBearer(credentials.apiToken),
          signal: AbortSignal.timeout(15_000),
        })
      ).body,
      label,
    );
  const application = record((await get(base, "pool application")).result, "Pool application");
  if (application.id !== receipt.applicationId || application.account_id !== receipt.accountId)
    throw new SafetyGateError("Pool application identity differs from its publication receipt");
  assertDigest(
    record(application.configuration, "Pool configuration").image,
    receipt.digest,
    "application",
  );
  if (worker) {
    const settings = record(
      (
        await get(
          `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(credentials.accountId)}/workers/scripts/${encodePathSegment(worker.workerName)}/settings`,
          "Pool Worker settings",
        )
      ).result,
      "Pool Worker settings",
    );
    if (!Array.isArray(settings.bindings))
      throw new SafetyGateError("Pool Worker bindings are missing");
    const hashes = settings.bindings
      .map((binding) => record(binding, "Pool Worker binding"))
      .filter((binding) => binding.name === "POOL_IMAGE_HASH");
    if (
      hashes.length !== 1 ||
      hashes[0]?.type !== "plain_text" ||
      hashes[0].text !== worker.inputHash
    )
      throw new PoolImagePending(
        "Pool Worker input hash differs from this candidate's publication receipt",
      );
  }

  const ids = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ state: "active", per_page: "100" });
    if (token) query.set("page_token", token);
    const reply = await get(`${base}/instances-v2?${query}`, "pool instances");
    if (!Array.isArray(reply.result)) throw new SafetyGateError("Pool instance list is missing");
    for (const value of reply.result) {
      const instance = record(value, "Pool instance");
      const id = stringField(instance.id, "Pool instance id");
      if (ids.has(id) || instance.application_id !== receipt.applicationId)
        throw new SafetyGateError("Pool instance list contains a duplicate or foreign instance");
      ids.add(id);
      if (record(instance.status, "Pool instance status").state !== "running")
        throw new PoolImagePending("Pool has an active instance that is not running");
      assertDigest(instance.image, receipt.digest, "instance");
    }
    const info = record(reply.resultInfo, "Pool instance pagination");
    const next = info.next_page_token;
    if (next === undefined || next === "") {
      if (ids.size === 0) throw new PoolImagePending("Pool has no running instance to verify");
      return { ...receipt, instances: [...ids] };
    }
    if (typeof next !== "string" || tokens.has(next))
      throw new SafetyGateError("Pool instance pagination is inconsistent");
    tokens.add(next);
    token = next;
  }
  throw new SafetyGateError("Pool instance pagination exceeded its bound");
}

function assertDigest(image: unknown, expected: string, label: string) {
  if (typeof image !== "string" || !image.endsWith(`@${expected}`))
    throw new PoolImagePending(`Pool ${label} image differs from the published candidate digest`);
}

export async function waitForPoolImage(
  value: unknown,
  candidate: string,
  credentials: CloudflareCredentials,
  origin: string,
  fetcher: Fetcher = fetch,
  options: Parameters<typeof waitForPoolStatus>[3] = {},
) {
  poolImageReceipt(value, candidate);
  let verified: Awaited<ReturnType<typeof assertPoolImage>> | undefined;
  await waitForPoolStatus(
    "Pool published candidate image",
    200,
    async (signal) => {
      const warm = await fetcher(`${origin}/pool/v1/pool`, { redirect: "manual", signal });
      await warm.body?.cancel();
      if (warm.status >= 500) return new Response(null, { status: 503 });
      if (warm.status !== 401)
        throw new SafetyGateError(`Pool readiness returned unexpected HTTP ${warm.status}`);
      try {
        verified = await assertPoolImage(value, candidate, credentials, (input, init) =>
          fetcher(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          }),
        );
        return new Response(null, { status: 200 });
      } catch (error) {
        if (error instanceof PoolImagePending) return new Response(null, { status: 503 });
        throw error;
      }
    },
    options,
  );
  if (!verified) throw new SafetyGateError("Pool image verification returned no evidence");
  return verified;
}

export async function waitForContainerImage<Health>(
  target: ContainerImageTarget,
  credentials: CloudflareCredentials,
  origin: string,
  fetcher: Fetcher = fetch,
  options: Parameters<typeof waitForPoolStatus>[3] = {},
  verifyHealth?: (signal: AbortSignal) => Promise<Health>,
) {
  let health: Health | undefined;
  await waitForPoolStatus(
    "Pool recovered container image",
    200,
    async (signal) => {
      const warm = await fetcher(`${origin}/pool/v1/pool`, { redirect: "manual", signal });
      await warm.body?.cancel();
      if (warm.status >= 500) return new Response(null, { status: 503 });
      if (warm.status !== 401)
        throw new SafetyGateError(`Pool readiness returned unexpected HTTP ${warm.status}`);
      try {
        await assertContainerImage(target, credentials, (input, init) =>
          fetcher(input, {
            ...init,
            signal: AbortSignal.any([signal, ...(init?.signal ? [init.signal] : [])]),
          }),
        );
        health = await verifyHealth?.(signal);
        return new Response(null, { status: 200 });
      } catch (error) {
        if (error instanceof PoolImagePending) return new Response(null, { status: 503 });
        throw error;
      }
    },
    options,
  );
  return health;
}
