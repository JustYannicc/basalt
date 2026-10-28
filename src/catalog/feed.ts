import { catalog } from "./settings.ts";

export interface FeedEntry {
  id: string;
  package: string;
  name: string;
  description: string;
  auth: unknown[];
  icons: { src: string; [key: string]: unknown }[];
  source: string;
  [key: string]: unknown;
}
export interface Feed { version: 1; apps: FeedEntry[] }
export interface FeedSource { package: string; files: unknown[] }
export interface FeedAddition { entry: FeedEntry; source?: FeedSource }
export interface Addition extends FeedAddition { source: FeedSource }

/** Resolve relative icons before the feed moves to our origin. */
export function mergeFeed(official: Feed, additions: readonly FeedAddition[] = []): Feed {
  if (official.version !== 1 || !Array.isArray(official.apps)) throw new Error("Invalid catalog");
  const apps = new Map<string, FeedEntry>();
  for (const entry of official.apps) {
    if (!entry.id || !entry.package || !Array.isArray(entry.icons)) throw new Error("Invalid app");
    // Every app lists with its description alone, so notices from the publisher are dropped too.
    const { connectionNotices: _notices, ...listing } = entry;
    apps.set(entry.id, {
      ...listing,
      source: `apps/${encodeURIComponent(entry.id)}.json`,
      icons: entry.icons.map(icon => ({ ...icon, src: new URL(icon.src, catalog.official).href })),
    });
  }
  for (const addition of additions) {
    if (apps.has(addition.entry.id)) throw new Error("Addition duplicates an official app");
    if (addition.source && addition.source.package !== addition.entry.package) throw new Error("Addition package mismatch");
    apps.set(addition.entry.id, addition.entry);
  }
  return { version: 1, apps: [...apps.values()] };
}
