import { catalog } from "../settings.ts";
import type { Addition, FeedEntry } from "../feed.ts";
import official from "./source.json" with { type: "json" };
import hostedRoutes from "./hosted-routes.source.json" with { type: "json" };
import { googleMapsLogo } from "./logo.ts";
import { hostedRoutesCatalogReference } from "./provider.ts";

const entry: FeedEntry = {
  id: "google-maps",
  package: official.package,
  name: "Google Maps",
  description:
    "Find places, plan routes, check addresses, and look up weather, air quality, elevation and time zones.",
  category: "developer tools",
  auth: [{ method: "apiKey", kind: "secrets", label: "Maps Platform API key" }],
  icons: [{ src: googleMapsLogo, mimeType: "image/png" }],
  source: "apps/google-maps.json",
};

const replaceOnce = (source: string, before: string, after: string) => {
  if (!source.includes(before)) throw new Error("The pinned Google Maps entry point no longer matches its overlay.");
  return source.replace(before, after);
};

const renderSource = (origin: string) => {
  const originalIndex = official.files.find((file) => file.path === "index.ts");
  if (!originalIndex) throw new Error("The pinned Google Maps source is incomplete.");

  let index = replaceOnce(
    originalIndex.content,
    'import { icons } from "./icon.js";',
    'import { icons } from "./icon.js";\nimport { createHostedRoutesProvider, hostedRoutesTools } from "./hosted-routes.js";',
  );
  index = replaceOnce(
    index,
    'export default defineApp(\n  { user: { accounts: { googleMaps: googleMaps.many() } }, icons },',
    `const hostedRoutes = createHostedRoutesProvider(${JSON.stringify(origin)});\n\nexport default defineApp(\n  { user: { accounts: { googleMaps: googleMaps.many(), hostedRoutes: hostedRoutes.many() } }, icons },`,
  );
  index = replaceOnce(
    index,
    `        user?.accounts.googleMaps ?? [],
        (account) => {
          const mount =`,
    `        [...(user?.accounts.googleMaps ?? []), ...(user?.accounts.hostedRoutes ?? [])],
        (account) => {
          if (account.method === "hostedRoutes")
            return router({ hosted: hostedRoutesTools(account) });
          const mount =`,
  );

  const files = official.files.map((file) => {
    if (file.path === "index.ts") return { ...file, content: index };
    if (file.path === "package.json") {
      const manifest = JSON.parse(file.content) as {
        dependencies?: Record<string, string>;
      };
      if (manifest.dependencies?.apps === undefined)
        throw new Error("The pinned Google Maps manifest has no apps dependency.");
      manifest.dependencies.apps = catalog.framework;
      return { ...file, content: `${JSON.stringify(manifest, null, 2)}\n` };
    }
    if (file.path === "README.md")
      return {
        ...file,
        content: `${file.content}\n## Signalbox hosted routes\n\nSignalbox adds the read-only hosted.computeRoutes tool, using the hosted Routes account when available. The original routes.computeRoutes and routes.computeRouteMatrix tools still use your Google Maps API key. Hosted route results include a Google Maps link and attribution.\n`,
      };
    return file;
  });
  return { ...official, files: [...files, { path: hostedRoutes.path, content: hostedRoutes.content }] };
};

export function googleMapsAddition(origin: string): Addition {
  const reference = hostedRoutesCatalogReference(origin);
  const rendered = renderSource(new URL(origin).origin);
  if (reference !== `${origin}/catalog/apps/google-maps.json`)
    throw new Error("Invalid Google Maps catalog reference.");
  return { entry, source: rendered };
}

export { hostedRoutesCatalogReference };
