/** The provider reads behind the stage table: GETs only. */
import { PlanetScaleApi } from "../deploy-safety/planetscale-api.ts";
import type { ProviderReads } from "./stage-table.ts";

export function stageReads(env: NodeJS.ProcessEnv, fetcher: typeof fetch = fetch): ProviderReads {
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const token = env.CLOUDFLARE_API_TOKEN ?? "";
  const planetscale = new PlanetScaleApi(
    {
      organization: env.PLANETSCALE_ORGANIZATION ?? "",
      tokenId: env.PLANETSCALE_API_TOKEN_ID ?? "",
      token: env.PLANETSCALE_API_TOKEN ?? "",
    },
    fetcher,
  );
  return {
    async application(id) {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/containers/applications/${encodeURIComponent(id)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (response.status === 404) return "absent";
      if (!response.ok)
        throw new Error(`Container application read failed with HTTP ${response.status}`);
      const body = (await response.json()) as {
        result?: { instances?: unknown; health?: { instances?: { active?: unknown } } };
      };
      const count = (value: unknown) => (typeof value === "number" ? value : undefined);
      return {
        configured: count(body.result?.instances),
        active: count(body.result?.health?.instances?.active),
      };
    },
    async branch(database, name) {
      try {
        const branch = await planetscale.getBranch(database, name);
        return { state: branch.state };
      } catch (error) {
        if (error instanceof Error && /HTTP 404\b/u.test(error.message)) return "absent";
        throw error;
      }
    },
  };
}
