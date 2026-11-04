import { catalog } from "./settings.ts";

/**
 * Serve an app package's source on the framework Basalt ships. A package that declares another
 * `apps` release would otherwise build on that published release, without Basalt's framework
 * fixes. Anything that is not such a package is returned unchanged, byte for byte.
 */
export function onServedFramework(text: string): string {
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    return text;
  }
  if (typeof source !== "object" || source === null || !Array.isArray((source as { files?: unknown }).files))
    return text;
  const files = (source as { files: unknown[] }).files;
  let changed = false;
  const served = files.map((file) => {
    if (typeof file !== "object" || file === null) return file;
    const { path, content } = file as { path?: unknown; content?: unknown };
    if (path !== "package.json" || typeof content !== "string") return file;
    let manifest: { dependencies?: Record<string, unknown> };
    try {
      manifest = JSON.parse(content);
    } catch {
      return file;
    }
    const declared = manifest.dependencies?.apps;
    if (declared === undefined || declared === catalog.framework) return file;
    changed = true;
    const pinned = { ...manifest, dependencies: { ...manifest.dependencies, apps: catalog.framework } };
    return { ...file, content: `${JSON.stringify(pinned, null, 2)}\n` };
  });
  return changed ? JSON.stringify({ ...source, files: served }) : text;
}
