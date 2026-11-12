// The vault page's Obsidian Markdown plugins resolve in the app's own build, not in this
// workspace; the page passes them to react-markdown as plugins.
declare module "@flowershow/remark-wiki-link" {
  const plugin: (options?: unknown) => void;
  export default plugin;
}
declare module "@r4ai/remark-callout" {
  const plugin: (options?: unknown) => void;
  export default plugin;
}
