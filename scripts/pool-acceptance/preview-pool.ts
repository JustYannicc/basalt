import { AcceptanceFailure, isObject } from "./types.ts";
import { PreviewHttpClient } from "./preview-http.ts";
import { requiredText } from "./preview-payload.ts";

export type PreviewSavedAccount = {
  readonly id: string;
  readonly requirement: "openai" | "anthropic";
};

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

  private async appOperation(
    kind: "query" | "mutate",
    name: string,
    input: unknown,
  ): Promise<unknown> {
    this.http.requireCookie();
    const path = `/api/organizations/${encodeURIComponent(this.organizationId)}/apps/${encodeURIComponent(this.poolAppId)}/data/${kind}`;
    const response = await this.http.request(
      path,
      {
        method: "POST",
        headers: this.http.headers({ Origin: this.origin, "Content-Type": "application/json" }),
        body: this.http.encodeJson({ name, input }, "Pool app request"),
      },
      "Pool app request",
    );
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
    if (
      href.origin !== this.origin ||
      href.pathname !== "/setup" ||
      href.username ||
      href.password
    ) {
      throw new AcceptanceFailure("Pool app setup URL did not match the preview origin");
    }
    const intent = new URLSearchParams(href.hash.slice(1)).get("intent");
    if (!intent) throw new AcceptanceFailure("Pool app setup URL omitted its intent");
    return intent;
  }

  async poolView(): Promise<PreviewPoolView> {
    const value = await this.appOperation("query", "view", { fresh: true });
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

  async selectAccount(account: PreviewSavedAccount): Promise<void> {
    await this.savedLink(account, "PUT");
  }

  async unselectAccount(account: PreviewSavedAccount): Promise<void> {
    await this.savedLink(account, "DELETE");
  }

  private async savedLink(account: PreviewSavedAccount, method: "PUT" | "DELETE"): Promise<void> {
    this.http.requireCookie();
    const id = encodeURIComponent(requiredText(account.id, "Saved account ID"));
    const prefix = `/api/organizations/${encodeURIComponent(this.organizationId)}`;
    const path = `${prefix}/apps/${encodeURIComponent(this.poolAppId)}/accounts/app/${account.requirement}/${id}`;
    const response = await this.http.request(
      path,
      {
        method,
        headers: this.http.headers({ Origin: this.origin }),
      },
      "Preview saved account selection",
    );
    await this.http.expectOk(response, "Preview saved account selection");
    await this.http.discardBody(response);
    const linksResponse = await this.http.request(
      `${prefix}/apps/${encodeURIComponent(this.poolAppId)}/accounts/app`,
      { method: "GET", headers: this.http.headers() },
      "Preview saved account links",
    );
    await this.http.expectOk(linksResponse, "Preview saved account links");
    const links = await this.http.readJson(linksResponse, "Preview saved account links");
    if (!Array.isArray(links) || !links.every(isObject))
      throw new AcceptanceFailure("Preview saved account links are invalid");
    const linked = links.some(
      (link) =>
        link.requirement === account.requirement &&
        isObject(link.account) &&
        link.account.id === account.id,
    );
    if (linked !== (method === "PUT"))
      throw new AcceptanceFailure("Preview saved account selection did not settle");
    // Uncheck releases this pool only. The stage's saved credential must still exist.
    const saved = await this.http.request(
      `${prefix}/accounts/${id}`,
      { method: "GET", headers: this.http.headers() },
      "Preview saved account preservation",
    );
    await this.http.expectOk(saved, "Preview saved account preservation");
    await this.http.discardBody(saved);
  }

  async verifyEmptyPool(): Promise<void> {
    const view = await this.poolView();
    if (view.accounts.length !== 0)
      throw new AcceptanceFailure("Preview pool was not empty before account selection");
  }

  async verifyAccounts(expectedIds: readonly string[]): Promise<void> {
    const expected = new Set(expectedIds);
    if (expected.size !== expectedIds.length)
      throw new AcceptanceFailure("Preview account IDs were not distinct");
    const view = await this.poolView();
    if (
      view.accounts.length !== expected.size ||
      new Set(view.accounts.map((account) => account.id)).size !== expected.size ||
      view.accounts.some((account) => !expected.has(account.id))
    ) {
      throw new AcceptanceFailure(
        "Preview pool accounts did not match the selected backend account IDs",
      );
    }
  }

  async verifyAccountsRemoved(ids: readonly string[]): Promise<void> {
    const removed = new Set(ids);
    const view = await this.poolView();
    if (view.accounts.some((account) => removed.has(account.id))) {
      throw new AcceptanceFailure("Selected preview accounts remained after cleanup");
    }
  }
}
