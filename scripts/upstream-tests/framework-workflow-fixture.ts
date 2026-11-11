export const question = "wfi_" + "a".repeat(64);
export const authored = `
import { defineApp, defineProvider, secrets, plain, workflow, object, string } from "apps";
const service = defineProvider({ name: "Workflow caller fixture", auth: {
  key: secrets({ label: "Key", fields: object({ region: plain(string()), token: string() }) }),
} });
export default defineApp({ user: { accounts: { service } } }, {
  workflows: { inspect: workflow({ input: object({}) }, async ctx => {
    const inspect = async step => {
      const value = { caller: step.user.id, region: step.user.accounts.service.fields.region };
      await fetch("https://marker.invalid/entered", { method: "POST", body: JSON.stringify(value) });
      return value;
    };
    const first = await ctx.step.do("before", inspect);
    await ctx.step.waitForInput("hold", { id: ${JSON.stringify(question)} });
    const second = await ctx.step.do("after", inspect);
    return { first, second };
  }) },
});`;

export const host = `
import { Effect } from "effect";
import { makeAppRunner } from "./packages/sdk/src/implementation/app-runner.ts";
import { credentialKey } from "./packages/sdk/src/implementation/credential-handles.ts";
import { AppWorkflows as ProductionWorkflows, AppOutbound, AppDataSupervisor } from "./packages/sdk/src/implementation/workerd-entry.ts";
export { AppOutbound, AppDataSupervisor };
export class AppWorkflows extends ProductionWorkflows {
  async run(event, step) {
    try {
      const observer = this.env.OBSERVER;
      // Workflow methods are RPC functions, so delegation calls them directly.
      const observed = new Proxy(step, { get(target, key) {
        const method = Reflect.get(target, key, target);
        if (key === "waitForEvent") return (...args) => {
          const pending = target[key](...args);
          const noted = observer.fetch("https://observer.invalid/parked", {
            method: "POST", body: JSON.stringify({ run: event.payload.run }),
          });
          return Promise.all([noted, pending]).then(([, value]) => value);
        };
        return typeof method === "function" ? (...args) => target[key](...args) : method;
      } });
      const output = await super.run(event, observed);
      await this.env.OBSERVER.fetch("https://observer.invalid/complete", {
        method: "POST", body: JSON.stringify({ run: event.payload.run, output }),
      });
      return output;
    } catch (error) {
      await this.env.OBSERVER.fetch("https://observer.invalid/failed", {
        method: "POST", body: JSON.stringify({ run: event.payload.run, error: JSON.stringify(error) }),
      });
      throw error;
    }
  }
}
export default {
  async fetch(request, env) {
    const input = await request.json();
    const { operation, run, event } = input;
    if (operation === "declare") {
      const runner = makeAppRunner({ loader: env.LOADER, outbound: () => env.PUBLIC_FETCH,
        credentialKey: credentialKey(env.CREDENTIAL_SECRET),
        data: () => ({ invoke: () => Effect.die("No facet"), cache: () => Effect.die("No cache"), cancel: () => Effect.void }),
        waitUntil: () => {},
      });
      return Response.json(await Effect.runPromise(runner.declare(input.loaded, {})));
    }
    if (operation === "create") {
      await env.RUNS.create({ id: run, params: { run } });
      return Response.json({ created: true });
    }
    const instance = await env.RUNS.get(run);
    if (operation === "signal") await instance.sendEvent({ type: event, payload: {} });
    return Response.json(await instance.status());
  },
};`;
