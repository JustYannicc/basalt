import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Plugin IDs and auth-provider IDs are separate parts of CPA's plugin contract. */
export function pluginOAuthProviderIds(root: string): string[] {
  const sources: unknown = JSON.parse(readFileSync(join(root, "containers/pool/sources.json"), "utf8"));
  if (!sources || typeof sources !== "object" || !("format_version" in sources) || sources.format_version !== 1)
    throw new Error("Invalid pinned pool source manifest");
  const plugins = "plugins" in sources ? sources.plugins : {};
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins))
    throw new Error("Invalid pinned pool plugins");
  const providers: string[] = [];
  for (const plugin of Object.values(plugins)) {
    if (!plugin || typeof plugin !== "object" || !("auth_providers" in plugin) || !Array.isArray(plugin.auth_providers))
      throw new Error("Pinned pool plugins must declare their auth providers");
    for (const id of plugin.auth_providers) {
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(id) || providers.includes(id))
        throw new Error("Invalid or duplicate pinned plugin auth provider");
      providers.push(id);
    }
  }
  return providers;
}
