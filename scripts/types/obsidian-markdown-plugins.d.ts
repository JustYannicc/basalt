// The vault page's Obsidian Markdown plugins resolve in the app's own build, not in this
// workspace. The page applies them straight to the Markdown tree, without unified.
declare module "@flowershow/remark-wiki-link" {
  export function syntax(options?: unknown): import("micromark-util-types").Extension;
  export function fromMarkdown(options?: unknown): import("mdast-util-from-markdown").Extension;
}
declare module "@r4ai/remark-callout" {
  export function remarkCallout(options?: unknown): (tree: import("mdast").Root) => void;
}
