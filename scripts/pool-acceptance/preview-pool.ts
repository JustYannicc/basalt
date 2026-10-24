import { AcceptanceFailure, isObject } from "./types.ts";
import { PreviewHttpClient } from "./preview-http.ts";
import { requiredText } from "./preview-payload.ts";

export type PreviewPoolConfig = {
  readonly origin: string;
  readonly organizationId: string;
  readonly poolAppId: string;
};

export type PreviewPoolView = {
  readonly isOwner: true;
  readonly accounts: readonly { readonly id: string }[];
};

function operationValue(responseBody: unknown): unknown {
  if (!isObject(responseBody) || responseBody.ok !== true || !("value" in responseBody)) {
    throw new AcceptanceFailure("Pool app operation did not return a successful result");
  }
  return responseBody.value;
}

export class PreviewPoolClient {
  private readonly origin: string;
  private readonly organizationId: string;
  private readonly poolAppId: string;
  private readonly http: PreviewHttpClient;

  constructor(config: PreviewPoolConfig, http: PreviewHttpClient) {
    this.origin = config.origin;
    this.organizationId = requiredText(config.organizationId, "Preview organization ID");
    this.poolAppId = requiredText(config.poolAppId, "Preview pool app ID");
    this.http = http;
  }

  private async appOperation(kind: "query" | "mutate", name: string, input: unknown): Promise<unknown> {
    this.http.requireCookie();
    const path = `/api/organizations/${encodeURIComponent(this.organizationId)}/apps/${encodeURIComponent(this.poolAppId)}/data/${kind}`;
    const response = await this.http.request(path, {
      method: "POST",
      headers: this.http.headers({ Origin: this.origin, "Content-Type": "application/json" }),
      body: this.http.encodeJson({ name, input }, "Pool app request"),
    }, "Pool app request");
    await this.http.expectOk(response, "Pool app request");
    return operationValue(await this.http.readJson(response, "Pool app response"));
  }

  async setupIntent(): Promise<string> {
    const value = await this.appOperation("query", "computerContext", {});
    if (!isObject(value) || typeof value.href !== "string") {
      throw new AcceptanceFailure("Pool app computer context omitted its setup URL");
    }
    let href: URL;
    try {
      href = new URL(value.href);
    } catch {
      throw new AcceptanceFailure("Pool app returned an invalid setup URL");
    }
    if (href.origin !== this.origin || href.pathname !== "/setup" || href.username || href.password) {
      throw new AcceptanceFailure("Pool app setup URL did not match the preview origin");
    }
    const intent = new URLSearchParams(href.hash.slice(1)).get("intent");
    if (!intent) throw new AcceptanceFailure("Pool app setup URL omitted its intent");
    return intent;
  }

  async poolView(): Promise<PreviewPoolView> {
    const value = await this.appOperation("query", "view", {});
    if (!isObject(value) || value.isOwner !== true || !Array.isArray(value.accounts)) {
      throw new AcceptanceFailure("Preview pool view did not return its owner's accounts");
    }
    const accounts = value.accounts.map((account: unknown) => {
      if (!isObject(account) || typeof account.id !== "string" || !account.id.trim()) {
        throw new AcceptanceFailure("Preview pool view omitted an account ID");
      }
      return { id: account.id };
    });
    return { isOwner: true, accounts };
  }

  async importAccount(loginFile: unknown): Promise<string> {
    const value = await this.appOperation("mutate", "addLoginFile", { file: loginFile });
    if (!isObject(value) || typeof value.accountId !== "string" || !value.accountId.trim()) {
      throw new AcceptanceFailure("Pool app did not return the imported account ID");
    }
    return value.accountId;
  }

  async removeAccount(id: string): Promise<void> {
    const value = await this.appOperation("mutate", "removeAccount", { id: requiredText(id, "Account ID") });
    if (value !== null) throw new AcceptanceFailure("Pool app did not confirm account removal");
  }

  async verifyEmptyPool(): Promise<void> {
    const view = await this.poolView();
    if (view.accounts.length !== 0) throw new AcceptanceFailure("Preview pool was not empty before account import");
  }

  async verifyAccounts(expectedIds: readonly string[]): Promise<void> {
    const expected = new Set(expectedIds);
    if (expected.size !== expectedIds.length) throw new AcceptanceFailure("Preview account IDs were not distinct");
    const view = await this.poolView();
    if (view.accounts.length !== expected.size || new Set(view.accounts.map(account => account.id)).size !== expected.size
      || view.accounts.some((account) => !expected.has(account.id))) {
      throw new AcceptanceFailure("Preview pool accounts did not match the imported account IDs");
    }
  }

  async verifyAccountsRemoved(ids: readonly string[]): Promise<void> {
    const removed = new Set(ids);
    const view = await this.poolView();
    if (view.accounts.some((account) => removed.has(account.id))) {
      throw new AcceptanceFailure("Imported preview accounts remained after cleanup");
    }
  }
}
