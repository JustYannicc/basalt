import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toHast } from "mdast-util-to-hast";
import { gfm } from "micromark-extension-gfm";
import { remarkCallout } from "@r4ai/remark-callout";
import {
  fromMarkdown as wikiFromMarkdown,
  syntax as wikiSyntax,
} from "@flowershow/remark-wiki-link";
import type { Root } from "hast";
import { fileHref, noteHref } from "./links.ts";

const callouts = remarkCallout();

/**
 * Obsidian-flavoured Markdown as a hast tree: the same parse, GFM and HTML conversion
 * react-markdown runs, without unified, whose vfile the app compiler can't resolve. Raw HTML
 * never reaches the tree. Wikilinks resolve by Obsidian's shortest-path rule against the vault's
 * paths and point inside this page; embeds point at vault files.
 */
export function noteTree(content: string, files: readonly string[]): Root {
  const wiki = {
    format: "shortestPossible" as const,
    files: [...files],
    urlResolver: ({ filePath, isEmbed }: { filePath: string; isEmbed: boolean }) =>
      isEmbed ? fileHref(filePath) : noteHref(filePath),
  };
  const tree = fromMarkdown(content, {
    extensions: [gfm(), wikiSyntax()],
    mdastExtensions: [gfmFromMarkdown(), wikiFromMarkdown(wiki)],
  });
  callouts(tree);
  // Without allowDangerousHtml, raw HTML nodes are dropped, as react-markdown's skipHtml does.
  return toHast(tree) as Root;
}
