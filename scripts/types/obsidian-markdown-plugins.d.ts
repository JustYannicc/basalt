// The vault page's Obsidian Markdown plugins resolve in the app's own build, not in this
// workspace; the page passes them to react-markdown as remark plugins.
declare module "@flowershow/remark-wiki-link" {
  const remarkWikiLink: (options?: unknown) => void;
  export default remarkWikiLink;
}
declare module "@r4ai/remark-callout" {
  export function remarkCallout(options?: unknown): void;
}
