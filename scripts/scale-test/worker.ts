import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { PoolContainer as FrozenPool, handlePoolWorkerRequest, type PoolEnvironment } from "../../.local/scale-candidate/src/pool/worker.ts";
import { mockSource, generatorSource, samplerSource } from "./sources.generated.ts";
interface Environment extends PoolEnvironment {
  TEST_DEADLINE: string;
  TEST_ADMIN: string;
  TEST_KEY_SEED: string;
  TEST_ORIGIN: string;
  Mock: DurableObjectNamespace<Mock>;
  Generator: DurableObjectNamespace<Generator>;
}
const deadline = (env: { TEST_DEADLINE: string }) => Number(env.TEST_DEADLINE);
const stub = (binding: DurableObjectNamespace) => binding.jurisdiction("eu").getByName("control-plane");
const denied = () => new Response(null, { status: 403 });

export class Outbound extends WorkerEntrypoint<Environment> {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.hostname !== "scale-mock.invalid" || Date.now() >= deadline(this.env)) return denied();
    return stub(this.env.Mock).fetch(new Request(`http://fixture${url.pathname}${url.search}`, request));
  }
}

export class PoolContainer extends FrozenPool {
  declare protected env: Environment;
  private intercepts: Promise<void>;
  constructor(ctx: DurableObjectState, env: Environment) {
    super(ctx, env);
    this.intercepts = this.installInterception();
    ctx.blockConcurrencyWhile(async () => {
      await this.intercepts;
      await ctx.storage.setAlarm(deadline(this.env));
    });
  }
  private async installInterception() {
    const outbound = (this.ctx.exports as unknown as { Outbound(options: { props: object }): Fetcher }).Outbound({ props: {} });
    await this.ctx.container!.interceptAllOutboundHttp(outbound);
    await this.ctx.container!.interceptOutboundHttps("*", outbound);
  }
  async alarm() {
    await this.ctx.container!.destroy();
    await this.ctx.storage.deleteAll();
  }
  async fetch(request: Request): Promise<Response> {
    if (Date.now() >= deadline(this.env)) return new Response(null, { status: 410 });
    await this.intercepts;
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/_harness/")) return super.fetch(request);
    if (request.headers.get("X-Scale-Admin") !== this.env.TEST_ADMIN) return denied();
    if (url.pathname === "/_harness/stop") {
      await this.ctx.container!.destroy();
      await this.ctx.storage.deleteAll();
      this.intercepts = this.installInterception();
      return Response.json({ stopped: true });
    }
    if (url.pathname === "/_harness/warm") {
      await this.installInterception();
      return super.fetch(new Request("http://pool/__warm"));
    }
    if (url.pathname === "/_harness/stats") {
      const proc = await this.ctx.container!.exec(["python3", "-c", samplerSource]);
      const output = await proc.output();
      const ready = await this.ctx.container!.getTcpPort(8318).fetch("http://pool/ready", {
        headers: { Authorization: `Bearer ${this.env.POOL_MANAGEMENT_KEY}` },
      });
      if (!ready.ok) return new Response(null, { status: 503 });
      return Response.json({ exitCode: output.exitCode, sample: JSON.parse(new TextDecoder().decode(output.stdout)), ready: await ready.json() });
    }
    if (url.pathname === "/_harness/isolation") {
      const code = "import urllib.request,json\nr=[]\nfor u in ['http://api.openai.com/v1/models','http://scale-mock.invalid/health']:\n try:\n  x=urllib.request.urlopen(u,timeout=10); r.append({'url':u,'status':x.status})\n except urllib.error.HTTPError as e:r.append({'url':u,'status':e.code})\nprint(json.dumps(r))";
      const proc = await this.ctx.container!.exec(["python3", "-c", code]);
      const output = await proc.output();
      return Response.json({ exitCode: output.exitCode, checks: JSON.parse(new TextDecoder().decode(output.stdout)) });
    }
    if (url.pathname.startsWith("/_harness/home/")) {
      const target = `/v8/management/${url.pathname.slice("/_harness/home/".length)}${url.search}`;
      const headers = new Headers(request.headers);
      headers.delete("X-Scale-Admin");
      headers.set("X-Management-Key", this.env.POOL_MANAGEMENT_KEY);
      return this.ctx.container!.getTcpPort(8327).fetch(new Request(`http://pool${target}`, { method: request.method, headers, body: request.body }));
    }
    if (url.pathname === "/_harness/db") {
      const { default: pg } = await import("pg");
      const databaseUrl = new URL(this.env.POOL_DATABASE_URL); databaseUrl.pathname = "/basalt_pool";
      const client = new pg.Client({ connectionString: databaseUrl.href, connectionTimeoutMillis: 5000, query_timeout: 5000 });
      client.on("error", () => {});
      try {
        await client.connect();
        const result = await client.query("SELECT COUNT(*)::int AS records, COUNT(DISTINCT request_id)::int AS requests FROM usage");
        const connections = await client.query("SELECT COUNT(*)::int AS connections FROM pg_stat_activity WHERE datname=current_database()");
        return Response.json({ usage: result.rows, connections: connections.rows });
      } finally { await client.end(); }
    }
    return new Response(null, { status: 404 });
  }
}

class Fixture extends DurableObject<Environment> {
  source = "";
  private starting?: Promise<void>;
  async alarm() { await this.ctx.container!.destroy(); await this.ctx.storage.deleteAll(); }
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/stop" && request.headers.get("X-Scale-Admin") === this.env.TEST_ADMIN) {
      await this.alarm(); return Response.json({ stopped: true });
    }
    if (Date.now() >= deadline(this.env)) return new Response(null, { status: 410 });
    const c = this.ctx.container!;
    if (!c.running) {
      this.starting ??= (async () => {
        c.start({ enableInternet: true, entrypoint: ["python3", "-c", this.source], env: { SCALE_DEADLINE: String(deadline(this.env) / 1000), SCALE_ADMIN: this.env.TEST_ADMIN, SCALE_ORIGIN: this.env.TEST_ORIGIN, SCALE_KEY_SEED: this.env.TEST_KEY_SEED } });
        await this.ctx.storage.setAlarm(deadline(this.env));
      })().finally(() => this.starting = undefined);
      await this.starting;
    }
    await c.setInactivityTimeout(300_000);
    return c.getTcpPort(8080).fetch(request);
  }
}
export class Mock extends Fixture { source = mockSource; }
export class Generator extends Fixture { source = generatorSource; }

export default {
  async fetch(request: Request, env: Environment) {
    try {
    if (Date.now() >= deadline(env)) return new Response(null, { status: 410 });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_test/")) {
      if (request.headers.get("X-Scale-Admin") !== env.TEST_ADMIN) return denied();
      if (url.pathname === "/_test/health") return Response.json({ role: "gateway", status: "ok" });
      const parts = url.pathname.slice(7).split("/");
      const role = parts.shift();
      if (role === "pool") {
        return await stub(env.PoolContainer).fetch(new Request(`http://pool/_harness/${parts.join("/")}${url.search}`, request));
      }
      if (role === "mock" || role === "gen") {
        const binding = role === "mock" ? env.Mock : env.Generator;
        const target = stub(binding);
        return await target.fetch(new Request(`http://fixture/${parts.join("/")}${url.search}`, request));
      }
      return new Response(null, { status: 404 });
    }
    return await handlePoolWorkerRequest(request, env);
    } catch {
      return Response.json({ harnessError: "Synthetic request failed" }, { status: 500 });
    }
  },
};
