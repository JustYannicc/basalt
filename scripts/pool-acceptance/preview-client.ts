import { AcceptanceFailure, isObject } from "./types.ts";
import { PreviewHttpClient, type PreviewStageRouter } from "./preview-http.ts";
import { PreviewPoolClient, type PreviewPoolView } from "./preview-pool.ts";
import {
  claimUrlFromPrompt,
  computerId,
  isoTimestamp,
  requiredText,
  setupPayload,
  type ComputerEvidence,
  type SetupCredentials,
  type SetupPayload,
} from "./preview-payload.ts";

const computerWaitMs = 60_000;
const computerPollMs = 1_000;

export type PreviewClientConfig = {
  readonly origin: string;
  readonly email: string;
  readonly password: string;
  readonly organizationId: string;
  readonly poolAppId: string;
};

export type PreviewClientOptions = {
  readonly stageRouter?: PreviewStageRouter;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly requestTimeoutMs?: number;
  readonly computerWaitMs?: number;
  readonly computerPollMs?: number;
};

export type PreviewNativeClient = "claude" | "codex";

export type RevokedCredentialProbe = {
  readonly client: PreviewNativeClient;
  readonly model: string;
};

function configuredOrigin(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new AcceptanceFailure("Preview origin must be an HTTP origin without a path");
  }
}

export class PreviewClient {
  private readonly origin: string;
  private readonly email: string;
  private readonly password: string;
  private readonly http: PreviewHttpClient;
  private readonly pool: PreviewPoolClient;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly computerWaitMs: number;
  private readonly computerPollMs: number;

  constructor(config: PreviewClientConfig, options: PreviewClientOptions = {}) {
    this.origin = configuredOrigin(config.origin);
    this.email = requiredText(config.email, "Preview email");
    this.password = requiredText(config.password, "Preview password");
    this.http = new PreviewHttpClient(this.origin, {
      stageRouter: options.stageRouter,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs,
    });
    this.pool = new PreviewPoolClient({
      origin: this.origin,
      organizationId: config.organizationId,
      poolAppId: config.poolAppId,
    }, this.http);
    this.now = options.now ?? (() => performance.now());
    this.delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.computerWaitMs = options.computerWaitMs ?? computerWaitMs;
    this.computerPollMs = options.computerPollMs ?? computerPollMs;
  }

  private async computerList(intent: string): Promise<unknown[]> {
    this.http.requireCookie();
    const url = new URL("/setup/v1/computers", this.origin);
    url.searchParams.set("intent", intent);
    const response = await this.http.request(`${url.pathname}${url.search}`, {
      method: "GET",
      headers: this.http.headers({ Origin: this.origin }),
    }, "Setup computer list");
    await this.http.expectOk(response, "Setup computer list");
    const payload = await this.http.readJson(response, "Setup computer list");
    if (!isObject(payload) || !Array.isArray(payload.computers)) {
      throw new AcceptanceFailure("Setup computer list omitted its computers array");
    }
    return payload.computers;
  }

  async signIn(): Promise<void> {
    const response = await this.http.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: this.http.headers({ Origin: this.origin, "Content-Type": "application/json" }, false),
      body: this.http.encodeJson({ email: this.email, password: this.password }, "Preview sign-in request"),
    }, "Preview sign-in");
    await this.http.expectOk(response, "Preview sign-in");
    const payload = await this.http.readJson(response, "Preview sign-in");
    if (!isObject(payload) || !isObject(payload.user) || typeof payload.user.id !== "string" || !payload.user.id) {
      throw new AcceptanceFailure("Preview sign-in did not return a signed-in user");
    }
    this.http.requireCookie();
  }

  poolView(): Promise<PreviewPoolView> { return this.pool.poolView(); }
  importAccount(loginFile: unknown): Promise<string> { return this.pool.importAccount(loginFile); }
  removeAccount(id: string): Promise<void> { return this.pool.removeAccount(id); }
  verifyEmptyPool(): Promise<void> { return this.pool.verifyEmptyPool(); }
  verifyAccounts(expectedIds: readonly string[]): Promise<void> { return this.pool.verifyAccounts(expectedIds); }
  verifyAccountsRemoved(ids: readonly string[]): Promise<void> { return this.pool.verifyAccountsRemoved(ids); }

  async claimComputer(name: string): Promise<{ id: string; payload: SetupPayload }> {
    this.http.requireCookie();
    const input = { intent: await this.pool.setupIntent(), name: requiredText(name, "Computer name") };
    const response = await this.http.request("/setup/v1/links", {
      method: "POST",
      headers: this.http.headers({ Origin: this.origin, "Content-Type": "application/json" }),
      body: this.http.encodeJson(input, "Setup link request"),
    }, "Setup link request");
    await this.http.expectOk(response, "Setup link request");
    const link = await this.http.readJson(response, "Setup link response");
    if (!isObject(link) || typeof link.computerId !== "string" || !link.computerId.trim()) {
      throw new AcceptanceFailure("Setup link response omitted its computer ID");
    }
    const id = computerId(link.computerId);
    try {
      const claimUrl = claimUrlFromPrompt(link.prompt, this.origin);
      claimUrl.searchParams.set("format", "json");

      // Claim URLs are one-time credentials. Never retry this request.
      const claim = await this.http.request(`${claimUrl.pathname}${claimUrl.search}`, {
        method: "GET",
        headers: this.http.headers({}, false),
      }, "Setup claim");
      await this.http.expectOk(claim, "Setup claim");
      return { id, payload: setupPayload(await this.http.readJson(claim, "Setup claim"), this.origin) };
    } catch (error) {
      // The link response already identifies the created computer. Clean it up if claim parsing,
      // the one-time fetch, or credential validation fails before the caller can track that ID.
      try {
        await this.revokeComputer(id);
      } catch {
        throw new AcceptanceFailure("Setup claim failed and its computer could not be revoked");
      }
      throw error;
    }
  }

  async waitForComputer(id: string): Promise<ComputerEvidence> {
    const target = computerId(id);
    const deadline = this.now() + this.computerWaitMs;
    for (;;) {
      // A fresh public app context keeps each observation inside the five-minute intent window.
      const computers = await this.computerList(await this.pool.setupIntent());
      const matches = computers.filter((entry) => isObject(entry) && entry.id === target);
      if (matches.length !== 1) throw new AcceptanceFailure("Setup list did not contain exactly the created computer");
      const computer = matches[0] as Record<string, unknown>;
      if (computer.state !== "active") throw new AcceptanceFailure("Created computer was not active after claim");
      if (!("firstModelRequestAt" in computer) || !("firstToolCallAt" in computer)) {
        throw new AcceptanceFailure("Setup list omitted computer usage timestamps");
      }
      const modelAt = computer.firstModelRequestAt === null
        ? null
        : isoTimestamp(computer.firstModelRequestAt, "First model request time");
      const toolAt = computer.firstToolCallAt === null
        ? null
        : isoTimestamp(computer.firstToolCallAt, "First tool call time");
      if (modelAt && toolAt) return { firstModelRequestAt: modelAt, firstToolCallAt: toolAt };

      const remaining = deadline - this.now();
      if (remaining <= 0) throw new AcceptanceFailure("Computer model and tool evidence remained incomplete before the polling deadline");
      await this.delay(Math.min(this.computerPollMs, remaining));
    }
  }

  async revokeComputer(id: string): Promise<void> {
    this.http.requireCookie();
    const target = computerId(id);
    const intent = await this.pool.setupIntent();
    const url = new URL(`/setup/v1/computers/${encodeURIComponent(target)}`, this.origin);
    url.searchParams.set("intent", intent);
    const response = await this.http.request(`${url.pathname}${url.search}`, {
      method: "DELETE",
      headers: this.http.headers({ Origin: this.origin }),
    }, "Computer revoke");
    await this.http.expectOk(response, "Computer revoke");
    const result = await this.http.readJson(response, "Computer revoke");
    if (!isObject(result) || result.success !== true) {
      throw new AcceptanceFailure("Preview did not confirm computer revocation");
    }

    const computers = await this.computerList(await this.pool.setupIntent());
    const matches = computers.filter((entry) => isObject(entry) && entry.id === target);
    if (matches.length !== 1) throw new AcceptanceFailure("Revoked computer was missing or duplicated in the setup list");
    const revokedAt = (matches[0] as Record<string, unknown>).revokedAt;
    if ((matches[0] as Record<string, unknown>).state !== "revoked" || revokedAt === null || revokedAt === undefined) {
      throw new AcceptanceFailure("Preview did not list the computer as revoked");
    }
    isoTimestamp(revokedAt, "Computer revoke time");
  }

  async verifyRevoked(credentials: SetupCredentials, probe: RevokedCredentialProbe): Promise<void> {
    const validated = setupPayload({
      version: 1,
      brand: { name: "preview", mcpServerName: "preview", setup: { id: "preview", marker: "preview" } },
      credentials,
      instructions: "",
    }, this.origin).credentials;
    const model = requiredText(probe.model, "Revocation probe model");
    const anthropic = probe.client === "claude";
    const modelPath = anthropic ? "/v1/messages" : "/v1/responses";
    const modelHeaders: Record<string, string> = anthropic
      ? { Authorization: `Bearer ${validated.modelKey}`, "anthropic-version": "2023-06-01" }
      : { "X-Api-Key": validated.modelKey };
    const modelBody = anthropic
      ? { model, max_tokens: 8, messages: [{ role: "user", content: "Reply with exactly OK." }] }
      : { model, input: "Reply with exactly OK.", max_output_tokens: 8 };
    const modelRequest = this.http.request(modelPath, {
      method: "POST",
      headers: this.http.headers({ ...modelHeaders, Accept: "application/json", "Content-Type": "application/json" }, false),
      body: this.http.encodeJson(modelBody, "Revoked model probe"),
    }, "Revoked model probe");
    const toolsRequest = this.http.request("/mcp", {
      method: "POST",
      headers: this.http.headers({
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${validated.toolsToken}`,
        "Content-Type": "application/json",
      }, false),
      body: this.http.encodeJson({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search", arguments: { query: "pool", limit: 1 } },
      }, "Revoked MCP probe"),
    }, "Revoked MCP probe");
    const [modelResponse, toolsResponse] = await Promise.all([modelRequest, toolsRequest]);
    const modelStatus = modelResponse.status;
    const toolsStatus = toolsResponse.status;
    await Promise.all([this.http.discardBody(modelResponse), this.http.discardBody(toolsResponse)]);
    if (modelStatus !== 401 && modelStatus !== 403) {
      throw new AcceptanceFailure(`Revoked model credential returned HTTP ${modelStatus}`);
    }
    if (toolsStatus !== 401 && toolsStatus !== 403) {
      throw new AcceptanceFailure(`Revoked MCP credential returned HTTP ${toolsStatus}`);
    }
  }

  async signOut(): Promise<void> {
    const cookie = this.http.requireCookie();
    const response = await this.http.request("/api/auth/sign-out", {
      method: "POST",
      headers: this.http.headers({ Origin: this.origin, "Content-Type": "application/json" }),
      body: "{}",
    }, "Preview sign-out");
    await this.http.expectOk(response, "Preview sign-out");
    await this.http.discardBody(response);
    const check = await this.http.request("/api/auth/get-session?disableCookieCache=true&disableRefresh=true", {
      method: "GET",
      headers: this.http.headers({ Cookie: cookie }, false),
    }, "Preview sign-out verification");
    if (!check.ok && check.status !== 401 && check.status !== 403) {
      const status = check.status;
      await this.http.discardBody(check);
      throw new AcceptanceFailure(`Preview sign-out verification returned HTTP ${status}`);
    }
    if (check.ok) {
      const session = await this.http.readJson(check, "Preview sign-out verification");
      if (session !== null) throw new AcceptanceFailure("Preview sign-out did not return a logged-out session");
    } else {
      await this.http.discardBody(check);
    }
    this.http.clearCookies();
  }
}

export type { ComputerEvidence, SetupCredentials, SetupPayload } from "./preview-payload.ts";
export type { PreviewPoolView } from "./preview-pool.ts";
