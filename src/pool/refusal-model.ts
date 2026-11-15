import snapshot from "./public-price-baseline.json" with { type: "json" };
import { priceAliases } from "./price-aliases.ts";
import { identifier } from "./model-history/record.ts";

const labs = new Map([
  ["anthropic", "claude"],
  ["openai", "codex"],
  ["xai", "xai"],
  ["google", "gemini-cli"],
  ["moonshotai", "kimi"],
  ["meta", "meta"],
]);
const models = new Map(
  Object.entries(snapshot.models)
    .filter(([vendor]) => labs.has(vendor))
    .map(([vendor, entries]) => [vendor, new Set(Object.keys(entries))]),
);

/** A requested identity is not a serving account. Unregistered aliases never acquire a guessed lab. */
export function refusalModelProvider(model: string | null, pathname: string): string | null {
  if (pathname === "/v1/systemone" || pathname === "/typesafe/v1/systemone") return "typesafe";
  if (model === null) return null;
  const parts = model.toLowerCase().split("/");
  if (parts.length > 2) return null;
  const bare = parts.at(-1)!;
  const candidates = [
    bare,
    ...(priceAliases([{ provider: "", model: bare }])[0]?.source_models ?? []),
  ];
  const matches = [...labs].filter(
    ([vendor, lab]) =>
      (parts.length === 1 || parts[0] === vendor || parts[0] === lab) &&
      candidates.some((candidate) => models.get(vendor)?.has(candidate)),
  );
  return matches.length === 1 ? matches[0]![1] : null;
}

/** Keep an unread branch only until dispatch; only a refusal reads bounded JSON, off the response path. */
export function captureRefusalModel(request: Request) {
  const pathModel =
    /^\/v1beta\/models\/([A-Za-z0-9._-]+):(?:streamGenerateContent|generateContent)$/.exec(
      new URL(request.url).pathname,
    )?.[1];
  const json = /^(?:application\/(?:json|[^;\s]+\+json)(?:;|$)|$)/i.test(
    request.headers.get("Content-Type") ?? "",
  );
  let copy =
    !pathModel && request.method === "POST" && json && request.body ? request.clone() : undefined;
  const discard = () => {
    const body = copy?.body;
    copy = undefined;
    void body?.cancel().catch(() => {});
  };
  return {
    discard,
    async read(): Promise<string | null> {
      if (pathModel) return pathModel;
      const body = copy?.body;
      copy = undefined;
      if (!body) return null;
      const reader = body.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Model metadata read timed out")), 250);
        });
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        for (;;) {
          const part = await Promise.race([reader.read(), expired]);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 2_097_152) return null;
          chunks.push(part.value);
        }
        const raw = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) {
          raw.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(raw));
        return typeof value === "object" && value !== null && "model" in value
          ? identifier(value.model)
          : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
