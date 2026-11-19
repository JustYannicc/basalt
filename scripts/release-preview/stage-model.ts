/**
 * One model request against a rehearsal stage's own pool, with no provider account: the stage's
 * smoke user signs in, finds the stage's seeded pool, claims a computer for a model key and sends
 * one small request. It reports the answer (status, Retry-After, body excerpt) and never throws, so a
 * stage mode decides what that answer means: the stuck runtime's retry advice, or, after a heal, a
 * request that got through the runtime and failed only for having no account.
 */
import { createHash, randomUUID } from "node:crypto";
import { PreviewClient } from "../pool-acceptance/preview-client.ts";

export type ModelAnswer =
  | { ok: true; status: number; retryAfter: string | null; body: string; ms: number }
  | { ok: false; step: string; error: string };

type Discovery = { organizationId: string; poolAppId: string };

/** The organization and pool the stage's auth seed created (`scripts/preview-auth/seed.ts`). */
async function discover(client: PreviewClient, origin: string, stage: string): Promise<Discovery> {
  const slug = `preview-smoke-${createHash("sha256").update(stage).digest("hex").slice(0, 12)}`;
  const read = async (path: string) => {
    const response = await client.http.request(
      path,
      { method: "GET", headers: client.http.headers({ Origin: origin }) },
      path,
    );
    await client.http.expectOk(response, path);
    return client.http.readJson(response, path);
  };
  const organizations = (await read("/api/auth/organization/list")) as {
    id: string;
    slug: string;
  }[];
  const organization = organizations.find((item) => item.slug === slug);
  if (!organization) throw new Error("The stage's smoke organization is missing");
  const inventory = (await read(
    `/api/organizations/${encodeURIComponent(organization.id)}/inventory`,
  )) as { apps?: { id?: string; name?: string }[] };
  const app = inventory.apps?.find((item) =>
    /^Preview smoke's pool(?: \d+)?$/u.test(item.name ?? ""),
  );
  if (!app?.id) throw new Error("The stage's smoke pool is missing");
  return { organizationId: organization.id, poolAppId: app.id };
}

export async function stageModelRequest(input: {
  origin: string;
  stage: string;
  email: string;
  password: string;
  model?: string;
}): Promise<ModelAnswer> {
  let step = "discover";
  try {
    const finder = new PreviewClient({
      ...input,
      organizationId: "discover",
      poolAppId: "discover",
    });
    await finder.signIn();
    const ids = await discover(finder, input.origin, input.stage);
    step = "claim";
    const client = new PreviewClient({ ...input, ...ids });
    await client.signIn();
    const computer = await client.claimComputer(`Rehearsal heal probe ${randomUUID().slice(0, 8)}`);
    const { modelUrl, modelKey } = computer.payload.credentials;
    step = "request";
    const started = Date.now();
    const response = await fetch(new URL("/v1/responses", modelUrl), {
      method: "POST",
      headers: { "X-Api-Key": modelKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: input.model ?? "gpt-5",
        input: "Reply with exactly OK.",
        max_output_tokens: 8,
      }),
      signal: AbortSignal.timeout(240_000),
    });
    const body = (await response.text())
      .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
      .slice(0, 600);
    return {
      ok: true,
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body,
      ms: Date.now() - started,
    };
  } catch (error) {
    return {
      ok: false,
      step,
      error: (error instanceof Error ? error.message : String(error))
        .replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]")
        .slice(0, 300),
    };
  }
}
