import { pathToFileURL } from "node:url";
import { deployment } from "../brand.ts";

type Namespace = { namespace: string; jurisdiction: string };
type Page = { result: Namespace[]; result_info?: { cursor?: string } };
export type ArtifactsRequest = (
  method: "GET" | "POST",
  cursor?: string,
) => Promise<Page | Namespace>;

export async function ensureEuNamespace(request: ArtifactsRequest, name: string): Promise<void> {
  let cursor: string | undefined;
  const find = async (): Promise<Namespace | undefined> => {
    const seen = new Set<string>();
    do {
      const page = await request("GET", cursor);
      if (!("result" in page) || !Array.isArray(page.result))
        throw new Error("Invalid namespace list");
      const existing = page.result.find((item) => item.namespace === name);
      if (existing) return existing;
      cursor = page.result_info?.cursor || undefined;
      if (cursor && seen.has(cursor)) throw new Error("Artifacts pagination repeated a cursor");
      if (cursor) seen.add(cursor);
    } while (cursor);
  };
  let namespace = await find();
  if (!namespace) {
    const created = await request("POST");
    if (!("namespace" in created)) throw new Error("Invalid namespace creation response");
    namespace = created;
  }
  if (namespace.namespace !== name || namespace.jurisdiction !== "eu") {
    throw new Error("Artifacts namespace must have immutable EU jurisdiction; deployment stopped");
  }
}

async function main(): Promise<void> {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) throw new Error("Missing Cloudflare deploy credentials");
  await ensureEuNamespace(async (method, cursor) => {
    const url = new URL(
      `https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces`,
    );
    if (method === "GET") {
      url.searchParams.set("limit", "200");
      if (cursor) url.searchParams.set("cursor", cursor);
    }
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(method === "POST"
        ? { body: JSON.stringify({ namespace: deployment.sourceNamespace, jurisdiction: "eu" }) }
        : {}),
    });
    if (!response.ok)
      throw new Error(`Cloudflare Artifacts ${method} failed with HTTP ${response.status}`);
    const body = await response.json();
    return method === "POST" && body.result ? body.result : body;
  }, deployment.sourceNamespace);
  console.log("Artifacts namespace uses EU jurisdiction");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
