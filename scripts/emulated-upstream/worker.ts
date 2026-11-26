import { DurableObject } from "cloudflare:workers";
import { mockRefusal, mockStarter, port, refusalPath } from "./mock-start.ts";

interface Environment {
  Mock: DurableObjectNamespace<Mock>;
  MOCK_KEY: string;
}

const encoder = new TextEncoder();

/** The key aimock also checks; refusing here first means an unkeyed caller never wakes the mock. */
async function keyed(request: Request, key: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const given = /^Bearer (.+)$/.exec(header)?.[1] ?? request.headers.get("x-api-key") ?? "";
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  return crypto.subtle.timingSafeEqual(a, b) && given.length > 0;
}

export class Mock extends DurableObject<Environment> {
  private starter?: ReturnType<typeof mockStarter>;
  async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) throw new Error("The mock's Durable Object runs without its container");
    this.starter ??= mockStarter(container, { AIMOCK_API_KEYS: this.env.MOCK_KEY });
    await this.starter.ready();
    // Idle for ten minutes, the instance stops; the next keyed call starts it again.
    await container.setInactivityTimeout(600_000);
    const mock = container.getTcpPort(port);
    const url = new URL(request.url);
    if (url.pathname === refusalPath)
      return Response.json(await mockRefusal(mock, this.env.MOCK_KEY));
    return mock.fetch(new Request(new URL(`${url.pathname}${url.search}`, "http://mock"), request));
  }
}

const mock = (env: Environment) => env.Mock.getByName("mock");

export default {
  async fetch(request: Request, env: Environment): Promise<Response> {
    if (!(await keyed(request, env.MOCK_KEY)))
      return Response.json({ error: { type: "authentication_error" } }, { status: 401 });
    return mock(env).fetch(request);
  },
} satisfies ExportedHandler<Environment>;
