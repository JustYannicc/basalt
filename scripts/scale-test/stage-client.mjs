import { worker } from "./settings.ts";

export function stageOrigin(subdomain) {
  if (!/^[a-z0-9-]+$/.test(subdomain ?? "")) throw new Error("Missing test endpoint suffix");
  const url = new URL("https://workers.dev");
  url.hostname = `${worker}.${subdomain}.workers.dev`;
  return url.origin;
}

export const stageClient = {
  fetch(origin, path, init) {
    const url = new URL(origin);
    if (!/^basalt-180-scale-gateway\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname) || url.protocol !== "https:" || url.port || url.username || url.password || !path.startsWith("/_test/"))
      throw new Error("Refusing a target outside the isolated test gateway");
    url.pathname = path;
    return globalThis.fetch(url, { ...init, redirect: "error" });
  },
};
