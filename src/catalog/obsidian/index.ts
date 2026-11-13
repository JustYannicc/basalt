import { obsidianIcons } from "./logo.ts";
import type { Addition } from "../feed.ts";
import source from "./source.json" with { type: "json" };

export const obsidian: Addition = {
  entry: {
    id: "obsidian",
    package: source.package,
    name: "Obsidian",
    description:
      "Read, search and edit an Obsidian vault in the cloud, even while its devices are off.",
    auth: [],
    instanceNoun: { singular: "vault", plural: "vaults" },
    instanceNameHint: "Use the vault's name in Obsidian. The app is named after it.",
    icons: obsidianIcons,
    source: "apps/obsidian.json",
  },
  source,
};
