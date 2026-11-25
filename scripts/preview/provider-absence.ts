import { cloudflareArtifactsApi, euNamespaceExists, stageNamespaces } from "../ensure-artifacts.ts";
import { PlanetScaleApi } from "../deploy-safety/planetscale-api.ts";
import type { PreviewIdentity } from "../environment.ts";
import {
  previewStacks,
  type PreviewDomainReference,
  type PreviewInventory,
  type PreviewProviderInventory,
} from "./inventory.ts";

const apiOrigin = "https://api.cloudflare.com/client/v4";
const pageSize = 100;
const controlPlane = { fetch: globalThis.fetch };

export interface PreviewProviderReadbacks {
  listWorkers(stage: string): Promise<readonly string[]>;
  listR2Buckets(): Promise<readonly string[]>;
  listContainerApplications(): Promise<
    readonly { readonly applicationId: string; readonly applicationName: string }[]
  >;
  listWorkerDomains(): Promise<
    readonly { readonly id: string; readonly hostname: string; readonly service: string }[]
  >;
  listPlanetScaleDatabases(name: string): Promise<readonly string[]>;
  artifactsNamespaceExists(name: string): Promise<boolean>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Provider readback is malformed");
  return value as Record<string, unknown>;
}

function bucketNames(inventory: PreviewInventory): string[] {
  const found = new Set<string>();
  for (const stack of previewStacks) {
    for (const entry of inventory.stacks[stack]) {
      if (entry.path.endsWith("/output")) continue;
      const value = record(entry.value);
      if (value.resourceType !== "Cloudflare.R2.Bucket") continue;
      const attr = value.attr && typeof value.attr === "object" ? record(value.attr) : {};
      if (typeof attr.bucketName !== "string" || !attr.bucketName)
        throw new Error("Preview R2 state is missing its provider bucket name");
      found.add(attr.bucketName);
    }
  }
  return [...found];
}

type ExpectedContainer = { readonly applicationId: string; readonly applicationName: string };
type ExpectedWorker = { readonly workerName: string; readonly hostnames: readonly string[] };

function exactResourceInventory(inventory: PreviewInventory): {
  readonly containers: readonly ExpectedContainer[];
  readonly workers: readonly ExpectedWorker[];
  readonly complete: boolean;
} {
  const containers = new Map<string, ExpectedContainer>();
  const workers = new Map<string, ExpectedWorker>();
  let complete = true;
  let foundContainerResource = false;
  let foundCustomDomain = false;
  for (const stack of previewStacks) {
    for (const entry of inventory.stacks[stack]) {
      if (entry.path.endsWith("/output")) continue;
      const value = record(entry.value);
      const attr = value.attr && typeof value.attr === "object" ? record(value.attr) : {};
      if (value.resourceType === "Cloudflare.Container") {
        foundContainerResource = true;
        if (
          typeof attr.applicationId !== "string" ||
          !attr.applicationId ||
          typeof attr.applicationName !== "string" ||
          !attr.applicationName
        )
          complete = false;
        else
          containers.set(attr.applicationId, {
            applicationId: attr.applicationId,
            applicationName: attr.applicationName,
          });
      }
      if (value.resourceType === "Cloudflare.Worker") {
        if (typeof attr.workerName !== "string" || !attr.workerName) {
          complete = false;
          continue;
        }
        const hostnames: string[] = [];
        const props = value.props && typeof value.props === "object" ? record(value.props) : {};
        const rawDomain = attr.domain ?? props.domain;
        if (rawDomain !== undefined && rawDomain !== null) {
          if (typeof rawDomain === "string") {
            hostnames.push(rawDomain);
          } else {
            const domain = record(rawDomain);
            const aliases = domain.aliases ?? [];
            const redirects = domain.redirects ?? [];
            if (
              typeof domain.name !== "string" ||
              !domain.name ||
              !Array.isArray(aliases) ||
              !Array.isArray(redirects) ||
              aliases.some((name) => typeof name !== "string") ||
              redirects.some((name) => typeof name !== "string")
            ) {
              complete = false;
            } else {
              hostnames.push(domain.name, ...(aliases as string[]), ...(redirects as string[]));
            }
          }
        }
        if (hostnames.length > 0) {
          foundCustomDomain = true;
        }
        const previous = workers.get(attr.workerName);
        workers.set(attr.workerName, {
          workerName: attr.workerName,
          hostnames: [...new Set([...(previous?.hostnames ?? []), ...hostnames])],
        });
      }
    }
  }
  if (!foundContainerResource || containers.size === 0 || !foundCustomDomain) complete = false;
  return { containers: [...containers.values()], workers: [...workers.values()], complete };
}

function cloudflareApi(account: string, token: string, origin: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const request = async (
    url: URL,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await controlPlane.fetch(url, {
        headers: { ...headers, ...extraHeaders },
        redirect: "error",
      });
    } catch {
      throw new Error("Cloudflare preview absence readback failed");
    }
    if (!response.ok)
      throw new Error(`Cloudflare preview absence readback failed with HTTP ${response.status}`);
    const body = record(await response.json());
    // The Workers custom domain list answers `errors: null` on success where other reads answer
    // `[]`; either is clean, and anything else (a missing list, or any error in it) is not.
    const clean = body.errors === null || (Array.isArray(body.errors) && body.errors.length === 0);
    if (body.success !== true || !clean)
      throw new Error("Cloudflare preview absence readback was not authoritative");
    return body;
  };
  return {
    async listWorkers(stage: string): Promise<readonly string[]> {
      const matched: string[] = [];
      let totalPages: number | undefined;
      for (let page = 1; page <= 10_000; page++) {
        const url = new URL(`${origin}/accounts/${encodeURIComponent(account)}/workers/scripts`);
        url.searchParams.set("page", String(page));
        url.searchParams.set("per_page", String(pageSize));
        const body = await request(url);
        if (!Array.isArray(body.result))
          throw new Error("Cloudflare Worker inventory is malformed");
        const info = body.result_info === undefined ? undefined : record(body.result_info);
        if (info?.total_pages !== undefined) {
          if (!Number.isSafeInteger(info.total_pages) || (info.total_pages as number) < 0)
            throw new Error("Cloudflare Worker pagination is malformed");
          totalPages = info.total_pages as number;
        }
        for (const raw of body.result) {
          const worker = record(raw);
          if (worker.tags === null || worker.tags === undefined) continue;
          if (!Array.isArray(worker.tags) || worker.tags.some((tag) => typeof tag !== "string"))
            throw new Error("Cloudflare Worker tags are malformed");
          if (worker.tags.includes(`alchemy:stage:${stage}`) && typeof worker.id === "string")
            matched.push(worker.id);
          else if (
            worker.tags.includes(`alchemy:stage:${stage}`) &&
            typeof worker.name === "string"
          )
            matched.push(worker.name);
          else if (worker.tags.includes(`alchemy:stage:${stage}`))
            throw new Error("Cloudflare Worker identity is missing");
        }
        if (totalPages !== undefined) {
          if (page >= totalPages) return matched;
        } else if (body.result.length < pageSize) {
          return matched;
        } else {
          throw new Error("Cloudflare Worker pagination omitted its continuation");
        }
      }
      throw new Error("Cloudflare Worker inventory exceeded its page limit");
    },
    async listR2Buckets(): Promise<readonly string[]> {
      const buckets: string[] = [];
      const seen = new Set<string>();
      let startAfter: string | undefined;
      const perPage = 1000;
      // The pinned provider lists R2 names by jurisdiction and startAfter; the response has no cursor.
      for (let page = 0; page < 10_000; page++) {
        const url = new URL(`${origin}/accounts/${encodeURIComponent(account)}/r2/buckets`);
        url.searchParams.set("per_page", String(perPage));
        if (startAfter) url.searchParams.set("start_after", startAfter);
        const body = await request(url, { "cf-r2-jurisdiction": "eu" });
        const result = record(body.result);
        if (!Array.isArray(result.buckets)) throw new Error("Cloudflare R2 inventory is malformed");
        const pageNames = result.buckets.map((raw) => {
          const bucket = record(raw);
          if (typeof bucket.name !== "string" || !bucket.name)
            throw new Error("Cloudflare R2 bucket identity is missing");
          if (seen.has(bucket.name)) throw new Error("Cloudflare R2 inventory repeated a bucket");
          seen.add(bucket.name);
          return bucket.name;
        });
        buckets.push(...pageNames);
        if (result.buckets.length < perPage || pageNames.length === 0) return buckets;
        const nextStart = pageNames.at(-1)!;
        if (startAfter !== undefined && nextStart <= startAfter)
          throw new Error("Cloudflare R2 inventory did not advance its startAfter cursor");
        startAfter = nextStart;
      }
      throw new Error("Cloudflare R2 inventory exceeded its page limit");
    },
    async listContainerApplications() {
      const url = new URL(
        `${origin}/accounts/${encodeURIComponent(account)}/containers/applications`,
      );
      const body = await request(url);
      if (!Array.isArray(body.result))
        throw new Error("Cloudflare ContainerApplication inventory is malformed");
      return body.result.map((raw) => {
        const item = record(raw);
        if (typeof item.id !== "string" || !item.id || typeof item.name !== "string" || !item.name)
          throw new Error("Cloudflare ContainerApplication readback is missing its ID or name");
        return { applicationId: item.id, applicationName: item.name };
      });
    },
    // Read to its last page: an absence proof that saw only the first page proves nothing about
    // the rest. The list says how many domains there are (`result_info.total_count`).
    async listWorkerDomains() {
      const domains: { id: string; hostname: string; service: string }[] = [];
      for (let page = 1; page <= 10_000; page++) {
        const url = new URL(`${origin}/accounts/${encodeURIComponent(account)}/workers/domains`);
        url.searchParams.set("page", String(page));
        const body = await request(url);
        if (!Array.isArray(body.result))
          throw new Error("Cloudflare Worker domain inventory is malformed");
        for (const raw of body.result) {
          const item = record(raw);
          if (
            typeof item.id !== "string" ||
            !item.id ||
            typeof item.hostname !== "string" ||
            !item.hostname ||
            typeof item.service !== "string" ||
            !item.service
          )
            throw new Error(
              "Cloudflare Worker domain readback is missing its ID, name, or service",
            );
          domains.push({ id: item.id, hostname: item.hostname, service: item.service });
        }
        const total =
          body.result_info === undefined || body.result_info === null
            ? undefined
            : record(body.result_info).total_count;
        if (total !== undefined && (!Number.isSafeInteger(total) || (total as number) < 0))
          throw new Error("Cloudflare Worker domain pagination is malformed");
        // Without a total, an empty page ends the list; with one, the list ends when it is read.
        if (total === undefined ? body.result.length === 0 : domains.length >= (total as number))
          return domains;
        if (body.result.length === 0)
          throw new Error("Cloudflare Worker domain list ended before its total");
      }
      throw new Error("Cloudflare Worker domain pagination did not finish");
    },
  };
}

export function providerReadbacks(
  source: NodeJS.ProcessEnv = process.env,
  // The Cloudflare API's origin; a test serves recorded answers from its own local one.
  cloudflareOrigin = apiOrigin,
): PreviewProviderReadbacks {
  const account = source.CLOUDFLARE_ACCOUNT_ID;
  const token = source.CLOUDFLARE_API_TOKEN;
  const organization = source.PLANETSCALE_ORGANIZATION;
  const tokenId = source.PLANETSCALE_API_TOKEN_ID;
  const planetScaleToken = source.PLANETSCALE_API_TOKEN;
  if (
    !account?.trim() ||
    !token?.trim() ||
    !organization?.trim() ||
    !tokenId?.trim() ||
    !planetScaleToken?.trim()
  )
    throw new Error("Preview provider absence credentials are missing");
  const cloudflare = cloudflareApi(account, token, cloudflareOrigin);
  const artifacts = cloudflareArtifactsApi(account, token);
  const planetscale = new PlanetScaleApi({ organization, tokenId, token: planetScaleToken });
  return {
    listWorkers: cloudflare.listWorkers,
    listR2Buckets: cloudflare.listR2Buckets,
    listContainerApplications: cloudflare.listContainerApplications,
    listWorkerDomains: cloudflare.listWorkerDomains,
    listPlanetScaleDatabases: async (name) =>
      (await planetscale.listDatabases(name)).map((database) => database.name),
    artifactsNamespaceExists: (name) => euNamespaceExists(artifacts, name),
  };
}

/** Capture exact live IDs and names for resources represented by the pinned Alchemy state rows. */
export async function capturePreviewProviderInventory(
  identity: PreviewIdentity,
  inventory: PreviewInventory,
  readbacks: PreviewProviderReadbacks = providerReadbacks(),
): Promise<PreviewProviderInventory> {
  const expected = exactResourceInventory(inventory);
  const [applications, domains] = await Promise.all([
    readbacks.listContainerApplications(),
    readbacks.listWorkerDomains(),
  ]);
  const containers = expected.containers.map((application) => {
    const sameName = applications.filter(
      (item) => item.applicationName === application.applicationName,
    );
    if (sameName.some((item) => item.applicationId !== application.applicationId))
      throw new Error("Preview ContainerApplication name resolved to a different provider ID");
    return application;
  });
  const byService = new Set(expected.workers.map((worker) => worker.workerName));
  const capturedDomains: PreviewDomainReference[] = domains
    .filter((domain) => byService.has(domain.service))
    .map((domain) => ({ id: domain.id, hostname: domain.hostname, service: domain.service }));
  for (const worker of expected.workers) {
    for (const hostname of worker.hostnames) {
      if (
        capturedDomains.some(
          (domain) => domain.hostname === hostname && domain.service === worker.workerName,
        )
      )
        continue;
      capturedDomains.push({ id: null, hostname, service: worker.workerName });
    }
  }
  const previewHostname = new URL(identity.origin).hostname;
  const originCaptured = expected.workers.some((worker) =>
    worker.hostnames.includes(previewHostname),
  );
  return {
    complete:
      expected.complete && containers.length > 0 && capturedDomains.length > 0 && originCaptured,
    containers,
    domains: capturedDomains,
  };
}

/** Require provider reads and exact-stage Alchemy state to agree that deletion completed. */
export async function verifyPreviewProvidersAbsent(
  identity: PreviewIdentity,
  inventory: PreviewInventory,
  readbacks: PreviewProviderReadbacks = providerReadbacks(),
): Promise<void> {
  const exact = exactResourceInventory(inventory);
  const workers = await readbacks.listWorkers(identity.stage);
  if (workers.length) throw new Error("Preview Cloudflare Workers are still present");

  const applications = await readbacks.listContainerApplications();
  if (
    inventory.providers.containers.some((expected) =>
      applications.some(
        (actual) =>
          actual.applicationId === expected.applicationId ||
          actual.applicationName === expected.applicationName,
      ),
    )
  )
    throw new Error("Preview ContainerApplications are still present");

  const domains = await readbacks.listWorkerDomains();
  if (
    inventory.providers.domains.some((expected) =>
      domains.some(
        (actual) =>
          (expected.id !== null && actual.id === expected.id) ||
          (actual.hostname === expected.hostname && actual.service === expected.service),
      ),
    )
  )
    throw new Error("Preview Worker domain bindings are still present");
  if (!exact.workers.some((worker) => worker.hostnames.length > 0))
    throw new Error("Preview state did not identify its custom domains");

  const expectedBuckets = bucketNames(inventory);
  if (expectedBuckets.length) {
    const present = new Set(await readbacks.listR2Buckets());
    if (expectedBuckets.some((name) => present.has(name)))
      throw new Error("Preview Cloudflare R2 buckets are still present");
  }
  const databases = await readbacks.listPlanetScaleDatabases(identity.databaseName);
  if (databases.some((name) => name === identity.databaseName))
    throw new Error("Preview PlanetScale database is still present");
  for (const namespace of stageNamespaces(identity.sourceNamespace))
    if (await readbacks.artifactsNamespaceExists(namespace))
      throw new Error("Preview Artifacts namespace is still present");
  if (
    !inventory.providers.complete ||
    !exact.complete ||
    inventory.providers.containers.length === 0 ||
    inventory.providers.domains.length === 0 ||
    !exact.workers.some((worker) => worker.hostnames.length > 0)
  )
    throw new Error(
      "Preview provider readbacks did not cover every paid application and domain binding",
    );
}
