import type { ClassificationReport } from "../releases/types.ts";
import type { WorkflowStatus } from "./contracts.ts";
import { SafetyGateError } from "./contracts.ts";
import { cloudflareResult, encodePathSegment, integerField, record, requestJson, stringField, withBearer, type Fetcher } from "./http.ts";

const apiOrigin = "https://api.cloudflare.com/client/v4";
const pageSize = 100;
const maximumPages = 10_000;
const statuses = new Set<WorkflowStatus>([
  "queued",
  "running",
  "paused",
  "errored",
  "terminated",
  "complete",
  "waiting",
  "waitingForPause",
  "unknown",
]);

export type CloudflareCredentials = {
  accountId: string;
  apiToken: string;
};

export type WorkflowSummary = {
  id: string;
  name: string;
};

export type WorkflowInstanceSummary = {
  id: string;
  workflowName: string;
  status: WorkflowStatus;
};

export type WorkflowDrainSnapshot = {
  workflowCount: number;
  instanceCount: number;
  unresolved: WorkflowInstanceSummary[];
  manualQuiescenceRequired: boolean;
};

export async function listCloudflareWorkflows(
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
): Promise<WorkflowSummary[]> {
  const all: WorkflowSummary[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  let expectedTotal: number | undefined;
  let expectedPages: number | undefined;

  for (let page = 1; page <= maximumPages; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: String(pageSize) });
    const url = `${apiOrigin}/accounts/${encodePathSegment(credentials.accountId)}/workflows?${query}`;
    const reply = await requestJson(fetcher, "Cloudflare", url, {
      method: "GET",
      headers: withBearer(credentials.apiToken),
    });
    const envelope = cloudflareResult(reply.body, "workflow list");
    if (!Array.isArray(envelope.result)) throw new SafetyGateError("Cloudflare workflow list omitted results");
    const info = record(envelope.resultInfo, "Cloudflare workflow pagination metadata");
    const resultPage = integerField(info.page, "Cloudflare workflow page number");
    const perPage = integerField(info.per_page, "Cloudflare workflow page size");
    const totalCount = integerField(info.total_count, "Cloudflare workflow total count");
    const totalPages = integerField(info.total_pages, "Cloudflare workflow total pages");
    const count = integerField(info.count, "Cloudflare workflow page count");
    if (resultPage !== page || perPage < 1 || perPage > pageSize || count !== envelope.result.length)
      throw new SafetyGateError("Cloudflare workflow pagination metadata is inconsistent");
    if (expectedTotal === undefined) {
      expectedTotal = totalCount;
      expectedPages = totalPages;
    } else if (totalCount !== expectedTotal || totalPages !== expectedPages) {
      throw new SafetyGateError("Cloudflare workflow pagination changed while listing");
    }
    if (totalPages === 0) {
      if (page !== 1 || totalCount !== 0 || envelope.result.length !== 0)
        throw new SafetyGateError("Cloudflare returned an uncertain empty workflow page");
      return all;
    }
    if (totalPages < page || totalPages > maximumPages)
      throw new SafetyGateError("Cloudflare workflow pagination bounds are invalid");

    for (const value of envelope.result) {
      const workflow = record(value, "Cloudflare workflow");
      const id = stringField(workflow.id, "Cloudflare workflow id");
      const name = stringField(workflow.name, "Cloudflare workflow name");
      if (ids.has(id) || names.has(name)) throw new SafetyGateError("Cloudflare workflow list contains duplicates");
      ids.add(id);
      names.add(name);
      all.push({ id, name });
    }
    if (page === totalPages) {
      if (all.length !== expectedTotal) throw new SafetyGateError("Cloudflare workflow list did not cover its reported total");
      return all;
    }
  }
  throw new SafetyGateError("Cloudflare workflow list exceeded the pagination limit");
}

export async function listWorkflowInstances(
  workflowName: string,
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
): Promise<WorkflowInstanceSummary[]> {
  const all: WorkflowInstanceSummary[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let expectedPerPage: number | undefined;

  for (let page = 0; page < maximumPages; page++) {
    const query = new URLSearchParams({ per_page: String(pageSize) });
    if (cursor !== undefined) query.set("cursor", cursor);
    const url = `${apiOrigin}/accounts/${encodePathSegment(credentials.accountId)}/workflows/${encodePathSegment(workflowName)}/instances?${query}`;
    const reply = await requestJson(fetcher, "Cloudflare", url, {
      method: "GET",
      headers: withBearer(credentials.apiToken),
    });
    const envelope = cloudflareResult(reply.body, `instances for ${workflowName}`);
    if (!Array.isArray(envelope.result)) throw new SafetyGateError("Cloudflare instance list omitted results");
    const info = record(envelope.resultInfo, "Cloudflare instance pagination metadata");
    const count = integerField(info.count, "Cloudflare instance page count");
    const perPage = integerField(info.per_page, "Cloudflare instance page size");
    if (perPage < 1 || perPage > pageSize || count !== envelope.result.length)
      throw new SafetyGateError("Cloudflare instance pagination metadata is inconsistent");
    if (expectedPerPage === undefined) expectedPerPage = perPage;
    else if (expectedPerPage !== perPage) throw new SafetyGateError("Cloudflare instance page size changed while listing");

    for (const value of envelope.result) {
      const instance = record(value, "Cloudflare workflow instance");
      const id = stringField(instance.id, "Cloudflare workflow instance id");
      const status = instance.status;
      if (typeof status !== "string" || !statuses.has(status as WorkflowStatus))
        throw new SafetyGateError("Cloudflare returned an unknown Workflow instance status");
      if (ids.has(id)) throw new SafetyGateError("Cloudflare instance list contains duplicate ids");
      ids.add(id);
      all.push({ id, workflowName, status: status as WorkflowStatus });
    }

    const nextCursor = info.cursor;
    if (nextCursor === undefined || nextCursor === null) {
      const reportedTotal = info.total_count;
      if (reportedTotal !== undefined && typeof reportedTotal === "number" && Number.isInteger(reportedTotal) && reportedTotal > all.length)
        throw new SafetyGateError("Cloudflare omitted a cursor before the reported instance total was reached");
      if (envelope.result.length === perPage)
        throw new SafetyGateError("Cloudflare returned a full instance page without a continuation cursor");
      return all;
    }
    if (typeof nextCursor !== "string" || !nextCursor)
      throw new SafetyGateError("Cloudflare returned an invalid instance cursor");
    if (cursors.has(nextCursor)) throw new SafetyGateError("Cloudflare repeated an instance cursor");
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new SafetyGateError("Cloudflare instance list exceeded the pagination limit");
}

export async function inspectWorkflowChange(
  report: ClassificationReport,
  credentials: CloudflareCredentials,
  fetcher: Fetcher = fetch,
): Promise<WorkflowDrainSnapshot> {
  if (!report.workflowChanged)
    return { workflowCount: 0, instanceCount: 0, unresolved: [], manualQuiescenceRequired: false };
  const workflows = await listCloudflareWorkflows(credentials, fetcher);
  const instances = await Promise.all(workflows.map((workflow) => listWorkflowInstances(workflow.name, credentials, fetcher)));
  const all = instances.flat();
  // An errored instance has stopped and re-runs only if someone restarts it, so it doesn't block a release.
  const unresolved = all.filter((instance) => !["complete", "terminated", "errored"].includes(instance.status));
  return { workflowCount: workflows.length, instanceCount: all.length, unresolved, manualQuiescenceRequired: true };
}

/**
 * A Workflow-identity release deploys only once every listed instance is complete, terminated or errored.
 * The listing is an observation, not a lock: whoever dispatches must have stopped new work first.
 */
export function assertWorkflowsDrained(snapshot: WorkflowDrainSnapshot): void {
  if (snapshot.unresolved.length > 0)
    throw new SafetyGateError(
      `${snapshot.unresolved.length} Workflow instance(s) are still queued, running, paused or waiting; drain or terminate them before releasing a Workflow identity change`,
    );
}
