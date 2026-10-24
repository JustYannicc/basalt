import { SafetyGateError } from "./contracts.ts";
import { encodePathSegment, integerField, record, requestJson, stringField, withPlanetScaleServiceToken, type Fetcher } from "./http.ts";

const apiOrigin = "https://api.planetscale.com/v1";
const pageSize = 100;
const maximumPages = 10_000;

export type PlanetScaleCredentials = {
  organization: string;
  tokenId: string;
  token: string;
};

export type DatabaseRecord = Record<string, unknown> & {
  name: string;
  kind: string;
  ready: boolean;
  default_branch: string;
};

export type BranchRecord = Record<string, unknown> & {
  id: string;
  name: string;
  kind: string;
  state: string;
  ready: boolean;
  production: boolean;
  cluster_name: string;
  has_replicas: boolean;
};

export type BackupRecord = Record<string, unknown> & {
  id: string;
  name: string;
  state: string;
  protected: boolean;
};

export class PlanetScaleApi {
  private readonly credentials: PlanetScaleCredentials;
  private readonly fetcher: Fetcher;

  constructor(
    credentials: PlanetScaleCredentials,
    fetcher: Fetcher = fetch,
  ) {
    this.credentials = credentials;
    this.fetcher = fetcher;
  }

  async listDatabases(databaseName: string): Promise<DatabaseRecord[]> {
    const query = new URLSearchParams({ q: databaseName, kind: "postgresql" });
    return this.listPages<DatabaseRecord>(
      `/organizations/${this.organization}/databases`,
      query,
      (value) => {
        const database = record(value, "PlanetScale database");
        return {
          ...database,
          name: stringField(database.name, "PlanetScale database name"),
          kind: stringField(database.kind, "PlanetScale database kind"),
          ready: requiredBoolean(database.ready, "PlanetScale database ready"),
          default_branch: stringField(database.default_branch, "PlanetScale default branch"),
        };
      },
    );
  }

  async getDatabase(databaseName: string): Promise<DatabaseRecord> {
    const value = await this.request(
      "GET",
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}`,
    );
    const database = record(value, "PlanetScale database");
    return {
      ...database,
      name: stringField(database.name, "PlanetScale database name"),
      kind: stringField(database.kind, "PlanetScale database kind"),
      ready: requiredBoolean(database.ready, "PlanetScale database ready"),
      default_branch: stringField(database.default_branch, "PlanetScale default branch"),
    };
  }

  async getBranch(databaseName: string, branchName: string): Promise<BranchRecord> {
    const value = await this.request(
      "GET",
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}/branches/${encodePathSegment(branchName)}`,
    );
    return parseBranch(value);
  }

  async listBranches(databaseName: string): Promise<BranchRecord[]> {
    return this.listPages<BranchRecord>(
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}/branches`,
      new URLSearchParams(),
      parseBranch,
    );
  }

  async listBackups(databaseName: string, branchName: string): Promise<BackupRecord[]> {
    return this.listPages<BackupRecord>(
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}/branches/${encodePathSegment(branchName)}/backups`,
      new URLSearchParams(),
      parseBackup,
    );
  }

  async createBackup(databaseName: string, branchName: string, name: string): Promise<BackupRecord> {
    const value = await this.request(
      "POST",
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}/branches/${encodePathSegment(branchName)}/backups`,
      { name, emergency: false },
      [201],
    );
    return parseBackup(value);
  }

  async getBackup(databaseName: string, branchName: string, backupId: string): Promise<BackupRecord> {
    const value = await this.request(
      "GET",
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}/branches/${encodePathSegment(branchName)}/backups/${encodePathSegment(backupId)}`,
    );
    return parseBackup(value);
  }

  async protectBackup(databaseName: string, branchName: string, backupId: string): Promise<BackupRecord> {
    const value = await this.request(
      "PATCH",
      `/organizations/${this.organization}/databases/${encodePathSegment(databaseName)}/branches/${encodePathSegment(branchName)}/backups/${encodePathSegment(backupId)}`,
      { protected: true },
    );
    return parseBackup(value);
  }

  private get organization(): string {
    return encodePathSegment(this.credentials.organization);
  }

  private async listPages<T>(
    path: string,
    baseQuery: URLSearchParams,
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    const all: T[] = [];
    let expectedCount: number | undefined;
    let expectedPages: number | undefined;

    for (let page = 1; page <= maximumPages; page++) {
      const query = new URLSearchParams(baseQuery);
      query.set("page", String(page));
      query.set("per_page", String(pageSize));
      const value = await this.request("GET", `${path}?${query}`);
      const response = record(value, "PlanetScale paginated response");
      if (response.type !== "list" || !Array.isArray(response.data))
        throw new SafetyGateError("PlanetScale list response is malformed");
      const currentPage = integerField(response.current_page, "PlanetScale current page");
      const perPage = integerField(response.per_page, "PlanetScale page size");
      const totalCount = integerField(response.total_count, "PlanetScale total count");
      const totalPages = integerField(response.total_pages, "PlanetScale total pages");
      const nextPage = response.next_page;
      if (currentPage !== page || perPage < 1 || perPage > pageSize)
        throw new SafetyGateError("PlanetScale pagination metadata is inconsistent");
      if (expectedCount === undefined) {
        expectedCount = totalCount;
        expectedPages = totalPages;
      } else if (totalCount !== expectedCount || totalPages !== expectedPages) {
        throw new SafetyGateError("PlanetScale pagination changed while listing");
      }
      for (const item of response.data) all.push(parse(item));

      if (totalPages === 0) {
        if (page !== 1 || totalCount !== 0 || response.data.length !== 0 || nextPage !== null)
          throw new SafetyGateError("PlanetScale returned uncertain empty pagination metadata");
        return all;
      }
      if (totalPages < page || totalPages > maximumPages)
        throw new SafetyGateError("PlanetScale pagination bounds are invalid");
      if (nextPage === null) {
        if (page !== totalPages || all.length !== expectedCount)
          throw new SafetyGateError("PlanetScale list ended before its reported total");
        return all;
      }
      if (typeof nextPage !== "number" || !Number.isInteger(nextPage) || nextPage !== page + 1)
        throw new SafetyGateError("PlanetScale returned an uncertain next page");
    }
    throw new SafetyGateError("PlanetScale list exceeded the pagination limit");
  }

  private async request(method: string, path: string, body?: unknown, acceptedStatuses: readonly number[] = [200]): Promise<unknown> {
    const reply = await requestJson(
      this.fetcher,
      "PlanetScale",
      `${apiOrigin}${path}`,
      {
        method,
        headers: withPlanetScaleServiceToken(
          this.credentials.tokenId,
          this.credentials.token,
          body === undefined ? {} : { "Content-Type": "application/json" },
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      acceptedStatuses,
    );
    return reply.body;
  }
}

function parseBranch(value: unknown): BranchRecord {
  const branch = record(value, "PlanetScale branch");
  return {
    ...branch,
    id: stringField(branch.id, "PlanetScale branch id"),
    name: stringField(branch.name, "PlanetScale branch name"),
    kind: stringField(branch.kind, "PlanetScale branch kind"),
    state: stringField(branch.state, "PlanetScale branch state"),
    ready: requiredBoolean(branch.ready, "PlanetScale branch ready"),
    production: requiredBoolean(branch.production, "PlanetScale branch production"),
    cluster_name: stringField(branch.cluster_name, "PlanetScale branch cluster size"),
    has_replicas: requiredBoolean(branch.has_replicas, "PlanetScale branch replicas"),
  };
}

function parseBackup(value: unknown): BackupRecord {
  const backup = record(value, "PlanetScale backup");
  return {
    ...backup,
    id: stringField(backup.id, "PlanetScale backup id"),
    name: stringField(backup.name, "PlanetScale backup name"),
    state: stringField(backup.state, "PlanetScale backup state"),
    protected: requiredBoolean(backup.protected, "PlanetScale backup protection"),
  };
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new SafetyGateError(`${label} is invalid`);
  return value;
}
