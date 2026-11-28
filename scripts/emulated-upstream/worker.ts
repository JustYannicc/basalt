import { DurableObject } from "cloudflare:workers";
import { calm, chaosFrom, gate, mockCalls, type Chaos } from "./gateway.ts";
import { mockStarter, port } from "./mock-start.ts";

interface Environment {
  Mock: DurableObjectNamespace<Mock>;
  MOCK_KEY: string;
}

const profileKey = "profile-b";

export class Mock extends DurableObject<Environment> {
  private starter?: ReturnType<typeof mockStarter>;
  private chaos?: Promise<Chaos>;
  private answer?: ReturnType<typeof mockCalls>;

  fetch(request: Request): Promise<Response> {
    this.answer ??= mockCalls({
      key: this.env.MOCK_KEY,
      store: {
        read: () =>
          (this.chaos ??= this.ctx.storage
            .get(profileKey)
            .then((saved) => chaosFrom(saved) ?? calm)
            // A failed read is not kept: the next call reads storage again.
            .catch((error) => {
              this.chaos = undefined;
              throw error;
            })),
        write: async (chaos) => {
          await this.ctx.storage.put(profileKey, chaos);
          this.chaos = Promise.resolve(chaos);
        },
      },
      start: async () => {
        const container = this.ctx.container;
        if (!container) throw new Error("The mock's Durable Object runs without its container");
        this.starter ??= mockStarter(container, { AIMOCK_API_KEYS: this.env.MOCK_KEY });
        await this.starter.ready();
        // Idle for ten minutes, the instance stops; the next keyed call starts it again.
        await container.setInactivityTimeout(600_000);
        return container.getTcpPort(port);
      },
    });
    return this.answer(request);
  }
}

const mock = (env: Environment) => env.Mock.getByName("mock");

export default {
  fetch: (request: Request, env: Environment) =>
    gate(request, env.MOCK_KEY, (keyed) => mock(env).fetch(keyed)),
} satisfies ExportedHandler<Environment>;
