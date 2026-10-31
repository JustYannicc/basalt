import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { ComputerStorage } from "../../src/pool/computers.ts";
import { FixtureDiagnostics } from "./sharing-diagnostics.ts";
import { cleanupFixtureDocker } from "./sharing-cleanup.ts";

const fixtureSigningKey = "ab".repeat(32);

export class MemoryStorage implements ComputerStorage {
  private values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function docker(args: string[], timeout = 60_000): string {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout.trim();
}

async function until(probe: () => Promise<boolean>, description: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch (error) { last = error; }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${description}`, { cause: last });
}

export interface HomeKey {
  api_key_id: number; api_key: string; user_id: number; display_name: string; channels: number[];
}
export interface HomeUser { id: number; username: string }
export interface HomeProvider { name: string; keys: { id: string; "api-key": string }[] }
export interface HomeEvent { method: string; path: string; status: number }

export interface SharingFixtureOptions {
  readonly image?: string;
  readonly failureContent?: string;
  readonly failureResponse?: string;
  readonly resourcePrefix?: string;
  readonly poolContainerArgs?: readonly string[];
  readonly postgresDataStorage?: "tmpfs" | "volume";
  readonly operationTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
  readonly onStage?: (stage: string) => void;
}

/** Owns only its uniquely named resources. Run the caller through heavy-slot. */
export class SharingFixture {
  private name: string;
  private poolContainerArgs: readonly string[];
  private operationTimeoutMs: number;
  private readinessTimeoutMs: number;
  private postgresDataStorage: "tmpfs" | "volume";
  private runArgs: string[] = [];
  private failureContent: string;
  private failureResponse: string;
  readonly diagnostics: FixtureDiagnostics;
  private onStage?: (stage: string) => void;
  // CI builds the pinned image once; a local run builds and later removes its own.
  private image: string;
  private resources: string[] = [];
  private network: string | undefined;
  private imageAttempted = false;
  private cleanupRegistered = false;
  private buildImage: boolean;
  private logRedactions = ["fixture-management-key", "fixture-only", fixtureSigningKey];
  private release = () => {};
  private gate = new Promise<void>((resolve) => { this.release = resolve; });
  private upstream = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const key = request.headers.authorization ?? "";
    this.calls.push(key);
    const pool = key === "Bearer fixture-p1" ? "P1" : key === "Bearer fixture-p2" ? "P2" : undefined;
    if (!pool) { response.writeHead(401); response.end("unknown fixture key"); return; }
    if (raw.includes("fail-request")) {
      response.writeHead(400, { "Content-Type": "application/json", "X-Private-Response": this.failureResponse });
      response.end(JSON.stringify({ error: { message: `${this.failureResponse} ${raw}`, type: "invalid_request_error" } })); return;
    }
    const slow = raw.includes("slow-stream");
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (content: string, finish: string | null = null) => response.write(`data: ${JSON.stringify({
      id: "fixture", object: "chat.completion.chunk", model: JSON.parse(raw).model,
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
      ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } } : {}),
    })}\n\n`);
    chunk(pool);
    if (slow) {
      this.slowStarted = true;
      await this.gate;
      for (const content of [" slow", " stream", " complete"]) { await delay(150); chunk(content); }
    }
    chunk("", "stop");
    response.end("data: [DONE]\n\n");
    if (slow) this.slowFinished = true;
  });
  readonly calls: string[] = [];
  readonly events: HomeEvent[] = [];
  slowStarted = false;
  slowFinished = false;
  home = "";
  node = "";
  readonly managementKey = "fixture-management-key";

  constructor(options: SharingFixtureOptions = {}) {
    this.name = `${options.resourcePrefix ?? "basalt-usage"}-${process.pid}-${Date.now().toString(36)}`;
    this.image = options.image ?? process.env.POOL_TEST_IMAGE ?? `${this.name}-pool:test`;
    this.buildImage = options.image === undefined && !process.env.POOL_TEST_IMAGE;
    this.failureContent = options.failureContent ?? "fail-request";
    this.failureResponse = options.failureResponse ?? "synthetic failure";
    this.diagnostics = new FixtureDiagnostics(this.name);
    this.poolContainerArgs = options.poolContainerArgs ?? [];
    this.operationTimeoutMs = options.operationTimeoutMs ?? 60_000;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 90_000;
    this.postgresDataStorage = options.postgresDataStorage ?? "tmpfs";
    this.onStage = options.onStage;
  }

  private exitCleanup = () => {
    const failures = this.cleanupDocker();
    if (failures.length) console.error(new AggregateError(failures, "Fixture exit cleanup failed"));
  };
  private cleanupDocker(): unknown[] {
    if (!this.cleanupRegistered) return [];
    this.cleanupRegistered = false;
    process.off("exit", this.exitCleanup);
    return cleanupFixtureDocker({
      containers: this.resources, network: this.network,
      image: this.imageAttempted ? this.image : undefined, timeout: this.operationTimeoutMs,
    });
  }
  private stage(value: string): void { this.onStage?.(value); }

  addLogRedactions(values: readonly string[]): void {
    this.logRedactions.push(...values.filter((value) => value.length > 0));
  }

  async captureContainerLogs(): Promise<{ pool: string; postgres: string }> {
    const read = (name: string): string => {
      const result = spawnSync("docker", ["logs", "--tail", "100", name], { encoding: "utf8", timeout: 5_000 });
      const raw = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      return this.logRedactions.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), raw)
        .replace(/postgresql:\/\/[^\s"']+/g, "[redacted-database-url]");
    };
    return { pool: read(`${this.name}-pool`), postgres: read(`${this.name}-postgres`) };
  }

  private origin(container: string, port: number) {
    const mapping = docker(["port", container, String(port)], this.operationTimeoutMs);
    assert.match(mapping, /^127\.0\.0\.1:\d+$/);
    return `http://${mapping}`;
  }
  async start(): Promise<void> {
    if (!this.cleanupRegistered) {
      this.cleanupRegistered = true;
      process.once("exit", this.exitCleanup);
    }
    console.log(`Resources: ${this.name}-postgres, ${this.name}-pool, ${this.image}`);
    if (this.buildImage) {
      this.stage("docker build started");
      this.imageAttempted = true;
      docker(["build", "--platform", process.env.POOL_TEST_PLATFORM ?? "linux/amd64", "--tag", this.image, "containers/pool"], 240_000);
      this.stage("docker build complete");
    }
    // A private network: on Linux, host.docker.internal can't reach ports published on loopback.
    this.network = `${this.name}-net`;
    this.stage("docker network create started");
    docker(["network", "create", this.network], this.operationTimeoutMs);
    this.stage("docker network create complete");
    const postgres = `${this.name}-postgres`;
    this.resources.push(postgres);
    this.stage("postgres container start started");
    docker(["run", "--detach", "--name", postgres, "--network", this.network, "--memory", "256m",
      ...(this.postgresDataStorage === "volume"
        ? ["--mount", "type=volume,destination=/var/lib/postgresql/data"]
        : ["--tmpfs", "/var/lib/postgresql/data:rw,size=256m"]),
      "--env", "POSTGRES_USER=fixture_admin", "--env", "POSTGRES_PASSWORD=fixture-only",
      "--env", "POSTGRES_DB=basalt_pool", "postgres:16"], this.operationTimeoutMs);
    this.stage("postgres container start complete");
    this.stage("postgres readiness started");
    await until(async () => {
      const result = spawnSync("docker", ["exec", postgres, "pg_isready", "-U", "fixture_admin", "-d", "basalt_pool"], {
        encoding: "utf8", timeout: this.operationTimeoutMs,
      });
      return result.status === 0;
    }, "isolated Postgres", this.readinessTimeoutMs);
    this.stage("postgres readiness complete");
    this.stage("upstream listener start started");
    await new Promise<void>((resolve) => this.upstream.listen(0, "0.0.0.0", resolve));
    this.stage("upstream listener start complete");
    const container = `${this.name}-pool`;
    this.resources.push(container);
    this.stage("pool container start started");
    this.runArgs = ["run", "--detach", "--name", container, "--network", this.network, "--platform", process.env.POOL_TEST_PLATFORM ?? "linux/amd64",
      "--memory", "256m", ...(process.platform === "linux" ? ["--add-host", "host.docker.internal:host-gateway"] : []),
      "--publish", "127.0.0.1::8317", "--publish", "127.0.0.1::8318", "--publish", "127.0.0.1::8327",
      "--env", `POOL_DATABASE_URL=postgresql://fixture_admin:fixture-only@${postgres}:5432/basalt_pool`,
      "--env", `POOL_MANAGEMENT_KEY=${this.managementKey}`, "--env", "POOL_MANAGEMENT_ALLOW_REMOTE=true",
      "--env", `POOL_APP_SIGNING_KEY=${fixtureSigningKey}`,
      ...this.poolContainerArgs];
    docker([...this.runArgs, this.image], this.operationTimeoutMs);
    this.stage("pool container start complete");
    this.stage("pool readiness started");
    this.home = this.origin(container, 8327);
    this.node = this.origin(container, 8317);
    const readiness = this.origin(container, 8318);
    await until(async () => (await fetch(`${readiness}/ready`, {
      headers: { Authorization: `Bearer ${this.managementKey}` }, signal: AbortSignal.timeout(3_000),
    })).ok, "pinned Home and node readiness", this.readinessTimeoutMs);
    this.stage("pool readiness complete");
    assert.equal((await fetch(`${this.home}/v8/management/users`)).status, 401);
    assert.equal((await fetch(`${this.node}/v1/models`)).status, 401);
    const address = this.upstream.address();
    assert.ok(address && typeof address !== "string");
    await this.data("/config", "PATCH", { "api-keys": { "openai-compatibility": ["p1", "p2"].map((pool) => ({
      name: `fixture-${pool}`, "base-url": `http://host.docker.internal:${address.port}/v1`,
      keys: [{ "api-key": `fixture-${pool}` }], models: ["fixture-model", "fixture-alt"].map((name) => ({ name, alias: name })),
    })) } });
    this.stage("pool fixture configuration complete");
  }
  async replaceImage(image: string): Promise<void> {
    const container = `${this.name}-pool`;
    docker(["stop", "--time", "20", container], this.operationTimeoutMs);
    docker(["rm", container], this.operationTimeoutMs);
    docker([...this.runArgs, image], this.operationTimeoutMs);
    this.home = this.origin(container, 8327);
    this.node = this.origin(container, 8317);
    const readiness = this.origin(container, 8318);
    await until(async () => (await fetch(`${readiness}/ready`, {
      headers: { Authorization: `Bearer ${this.managementKey}` }, signal: AbortSignal.timeout(3_000),
    })).ok, "replacement privacy image readiness", this.readinessTimeoutMs);
  }
  useDatabaseRole(role: string): void {
    const index = this.runArgs.findIndex((value) => value.startsWith("POOL_DATABASE_URL="));
    assert.ok(index >= 0, "Fixture database configuration must exist before switching roles");
    const url = new URL(this.runArgs[index]!.slice("POOL_DATABASE_URL=".length));
    url.username = role;
    this.runArgs[index] = `POOL_DATABASE_URL=${url}`;
  }

  async crashAndReplace(image: string): Promise<void> {
    docker(["kill", "--signal", "KILL", `${this.name}-pool`], this.operationTimeoutMs);
    await this.replaceImage(image);
  }

  async fetchHome(input: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("X-Management-Key", this.managementKey);
    const url = new URL(input, this.home);
    const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(15_000) });
    this.events.push({ method: init?.method ?? "GET", path: url.pathname + url.search, status: response.status });
    return response;
  }
  async data<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetchHome(`/v8/management${path}`, {
      method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
    return value as T;
  }
  async keys() { return (await this.data<{ items: HomeKey[] }>("/access/api-keys")).items; }
  async users() { return (await this.data<{ users: HomeUser[] }>("/users")).users; }
  async model(key: string, session: string, slow: boolean | "fail" = false, model = "fixture-model"): Promise<Response> {
    return fetch(`${this.node}/v1/chat/completions`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Session-ID": session },
      body: JSON.stringify({ model, stream: true, max_tokens: 32, prompt_cache_key: session,
        messages: [{ role: "user", content: slow === "fail" ? this.failureContent : slow ? "slow-stream" : "Reply with the pool name" }] }),
      signal: AbortSignal.timeout(20_000),
    });
  }
  finishStream() { this.release(); }
  async close(): Promise<void> {
    this.release();
    const failures: unknown[] = [];
    try {
      this.upstream.closeAllConnections();
      const upstreamClosed = new Promise<void>((resolve) => this.upstream.close(() => resolve()));
      if (!await Promise.race([upstreamClosed.then(() => true), delay(5_000, undefined, { ref: false }).then(() => false)]))
        failures.push(new Error("Synthetic OpenAI fixture listener did not close within 5 seconds"));
    } catch (error) { failures.push(error); }
    finally {
      failures.push(...this.cleanupDocker());
    }
    if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
  }
}
