import { FileSystemAdapter, Platform, parseLinktext, normalizePath, type Plugin } from "obsidian";
import { createBinaryIo } from "../binary-files.ts";
import { object, text, number } from "../http.ts";
import { newDeviceId, type PluginStore } from "../store.ts";
import type { createLocalVault } from "../local-vault.ts";
import type { DesktopReader } from "../binary-file-types.ts";
function desktopReader(plugin: Plugin): DesktopReader | undefined {
  const { adapter } = plugin.app.vault;
  if (!Platform.isDesktopApp || !(adapter instanceof FileSystemAdapter)) return undefined;
  if (!plugin.manifest.dir)
    throw new Error("Obsidian did not provide this plugin's installation path");
  // Bundled into main.js but evaluated only here, so phones never load its Node built-ins.
  const module: unknown = require("./desktop-reader.cjs");
  const exported = object(module);
  if (typeof exported.createReader !== "function")
    throw new Error("The desktop byte reader is invalid. Reinstall Signalbox Sync.");
  const raw: unknown = exported.createReader(adapter.getBasePath()),
    reader = object(raw);
  const snapshot = reader.snapshot,
    read = reader.read;
  if (typeof snapshot !== "function" || typeof read !== "function")
    throw new Error("The desktop byte reader is invalid");
  return {
    async snapshot(path) {
      const raw: unknown = await snapshot(path);
      if (raw === null) return null;
      const value = object(raw);
      return { stamp: text(value, "stamp"), bytes: number(value, "bytes") };
    },
    async read(path, expected, offset, length) {
      const raw: unknown = await read(path, expected, offset, length);
      if (!(raw instanceof Uint8Array) || raw.length !== length)
        throw new Error("The desktop byte reader returned an invalid range");
      return raw.slice();
    },
  };
}
export function obsidianBinaryIo(
  plugin: Plugin,
  local: ReturnType<typeof createLocalVault>,
  store: PluginStore,
  appId: string,
  signal: AbortSignal,
) {
  if (!plugin.manifest.dir || !/^[A-Za-z0-9_-]{1,128}$/u.test(appId))
    throw new Error("Invalid local sync identity");
  const { vault, metadataCache } = plugin.app,
    native = desktopReader(plugin);
  return createBinaryIo({
    adapter: vault.adapter,
    vault,
    local,
    privateRoot: normalizePath(`${plugin.manifest.dir}/cache/${appId}`),
    transferRoot: `Basalt transfers/${store.device}/${appId}`,
    ownership: store.transfers,
    id: newDeviceId,
    signal,
    ...(native ? { desktop: native } : {}),
    links: async (path) => {
      const file = vault.getFileByPath(path);
      if (!file) return [];
      const metadata = metadataCache.getFileCache(file),
        links = [...(metadata?.embeds ?? []), ...(metadata?.links ?? [])];
      return [
        ...new Set(
          links.map(
            (link) =>
              metadataCache.getFirstLinkpathDest(link.link, path)?.path ??
              parseLinktext(link.link).path,
          ),
        ),
      ];
    },
  });
}
