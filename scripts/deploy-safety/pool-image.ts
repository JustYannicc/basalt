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
import { boundFleet, type BoundFleetApplication } from "./pool-image-fleet.ts";

export class PoolImagePending extends SafetyGateError {}

export interface PoolImageObservation {
  verifiedPath: "root" | "bound-fleet";
  instances: string[];
  fleet?: (BoundFleetApplication & { digest: string; instances: string[] })[];
}

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
  return { ...receipt, ...(await assertPoolImageTarget(receipt, receipt, credentials, fetcher)) };
}

export interface ContainerImageTarget {
  applicationId: string;
  accountId: string;
  digest: string;
}

/**
 * Recovery must prove old instances before it can restore the old Worker and its input hash. It
 * reads no Worker bindings, so it can never substitute a fleet for its exact recorded container.
 */
export async function assertContainerImage(
  target: ContainerImageTarget,
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
) {
  if (!target.applicationId || !target.accountId || !/^sha256:[a-f0-9]{64}$/.test(target.digest))
    throw new SafetyGateError("Container image recovery target is invalid");
  return { ...target, ...(await assertImages(target, credentials, fetcher)) };
}

export async function assertPoolImageTarget(
  target: ContainerImageTarget,
  worker: { workerName: string; inputHash: string },
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
) {
  if (
    !target.applicationId ||
    !target.accountId ||
    !/^sha256:[a-f0-9]{64}$/u.test(target.digest) ||
    !/^[a-f0-9]{16}$/u.test(worker.inputHash)
  )
    throw new SafetyGateError("Pool image target or Worker input is invalid");
  return assertImages(target, credentials, fetcher, worker);
}

type Get = (url: string, label: string) => Promise<{ result: unknown; resultInfo: unknown }>;

async function assertImages(
  receipt: ContainerImageTarget,
  credentials: CloudflareCredentials,
  fetcher: Fetcher,
  worker?: { workerName: string; inputHash: string },
): Promise<PoolImageObservation> {
  if (receipt.accountId !== credentials.accountId)
    throw new SafetyGateError("Pool image receipt belongs to another account");
  const account = `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(credentials.accountId)}`;
  const get: Get = async (url, label) =>
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
  await readApplication(get, account, receipt, {
    label: "Pool application",
    source: "its publication receipt",
    digest: receipt.digest,
  });
  let bindings: unknown[] | undefined;
  if (worker) {
    const settings = record(
      (
        await get(
          `${account}/workers/scripts/${encodePathSegment(worker.workerName)}/settings`,
          "Pool Worker settings",
        )
      ).result,
      "Pool Worker settings",
    );
    if (!Array.isArray(settings.bindings))
      throw new SafetyGateError("Pool Worker bindings are missing");
    bindings = settings.bindings;
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
  const instances = await listInstances(get, account, receipt.applicationId, {
    label: "Pool",
    digest: receipt.digest,
    expected: "the published candidate digest",
  });
  if (instances.length) return { verifiedPath: "root", instances };
  // A scale-out release retires the root runtime once a bound fleet primary serves, so an empty
  // root is only acceptable when the PoolWorker's own bindings name a serving fleet.
  const fleet = bindings && boundFleet(bindings, receipt.applicationId);
  if (!fleet) throw new PoolImagePending("Pool has no running instance to verify");
  const observed: NonNullable<PoolImageObservation["fleet"]> = [];
  for (const application of fleet.applications) {
    const label = `Pool ${application.color} fleet application`;
    const digest = await readApplication(get, account, receipt, {
      label,
      source: `its PoolWorker binding POOL_${application.color}_APPLICATION_ID`,
      applicationId: application.applicationId,
    });
    observed.push({
      ...application,
      digest,
      instances: await listInstances(get, account, application.applicationId, {
        label,
        digest,
        expected: "its configured digest",
      }),
    });
  }
  const all = observed.flatMap((application) => application.instances);
  const repeated = all.find((id, index) => all.indexOf(id) !== index);
  if (repeated)
    throw new SafetyGateError(
      `Pool fleet instance ${repeated} is listed by both fleet applications`,
    );
  if (
    !observed.some(
      (application) =>
        application.imageInput === fleet.desiredImageInput && application.instances.length,
    )
  )
    throw new PoolImagePending(
      `Pool has no running instance in its root or in a bound fleet application on POOL_DESIRED_IMAGE_INPUT ${fleet.desiredImageInput}`,
    );
  return { verifiedPath: "bound-fleet", instances: all, fleet: observed };
}

/** Returns the application's immutable image digest after checking its identity and image. */
async function readApplication(
  get: Get,
  account: string,
  receipt: ContainerImageTarget,
  expected: { label: string; source: string; digest?: string; applicationId?: string },
) {
  const applicationId = expected.applicationId ?? receipt.applicationId;
  const application = record(
    (
      await get(
        `${account}/containers/applications/${encodePathSegment(applicationId)}`,
        expected.label,
      )
    ).result,
    expected.label,
  );
  if (application.id !== applicationId)
    throw new SafetyGateError(`${expected.label} identity differs from ${expected.source}: id`);
  if (application.account_id !== receipt.accountId)
    throw new SafetyGateError(
      `${expected.label} identity differs from ${expected.source}: account_id`,
    );
  const image = record(application.configuration, `${expected.label} configuration`).image;
  if (expected.digest) {
    assertDigest(
      image,
      expected.digest,
      `${expected.label} image`,
      "the published candidate digest",
    );
    return expected.digest;
  }
  const digest =
    typeof image === "string" ? /@(sha256:[a-f0-9]{64})$/u.exec(image)?.[1] : undefined;
  if (!digest)
    throw new SafetyGateError(
      `${expected.label} configuration.image is not pinned by an immutable digest`,
    );
  if (!(image as string).startsWith(`registry.cloudflare.com/${receipt.accountId}/`))
    throw new SafetyGateError(
      `${expected.label} configuration.image is outside this account's registry`,
    );
  return digest;
}

async function listInstances(
  get: Get,
  account: string,
  applicationId: string,
  expected: { label: string; digest: string; expected: string },
) {
  const base = `${account}/containers/applications/${encodePathSegment(applicationId)}`;
  const ids = new Set<string>();
  const tokens = new Set<string>();
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ state: "active", per_page: "100" });
    if (token) query.set("page_token", token);
    const reply = await get(`${base}/instances-v2?${query}`, `${expected.label} instances`);
    if (!Array.isArray(reply.result))
      throw new SafetyGateError(`${expected.label} instance list is missing`);
    for (const value of reply.result) {
      const instance = record(value, `${expected.label} instance`);
      const id = stringField(instance.id, `${expected.label} instance id`);
      if (ids.has(id) || instance.application_id !== applicationId)
        throw new SafetyGateError(
          `${expected.label} instance list contains a duplicate or foreign instance (${id})`,
        );
      ids.add(id);
      if (record(instance.status, `${expected.label} instance status`).state !== "running")
        throw new PoolImagePending(
          `${expected.label} has an active instance that is not running (${id})`,
        );
      assertDigest(
        instance.image,
        expected.digest,
        `${expected.label} instance image`,
        expected.expected,
      );
    }
    const info = record(reply.resultInfo, `${expected.label} instance pagination`);
    const next = info.next_page_token;
    if (next === undefined || next === "") return [...ids];
    if (typeof next !== "string" || tokens.has(next))
      throw new SafetyGateError(`${expected.label} instance pagination is inconsistent`);
    tokens.add(next);
    token = next;
  }
  throw new SafetyGateError(`${expected.label} instance pagination exceeded its bound`);
}

function assertDigest(image: unknown, expected: string, label: string, describe: string) {
  if (typeof image !== "string" || !image.endsWith(`@${expected}`))
    throw new PoolImagePending(`${label} differs from ${describe}`);
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
