/**
 * The module specifiers a TypeScript source imports, in the order they appear: static imports and
 * re-exports, which the formatter starts on their own line, side-effect imports, and dynamic
 * imports. Prose is not an import: a comment that says "an import's insert" or "from 'x'" in the
 * middle of a line matches nothing, so a reworded comment can never add or hide a source.
 */
export function importSpecifiers(text: string): string[] {
  const found: { at: number; specifier: string }[] = [];
  for (const pattern of [
    // `import … from "x"`, across lines: only names, braces, commas and `*` before `from`.
    /^[ \t]*import\s+(?:type\s+)?[\w\s{},*$]*?\bfrom\s*["']([^"'\n]+)["']/gmu,
    // `export * from "x"`, `export * as y from "x"` and `export { … } from "x"`.
    /^[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[\w\s,$]*\})\s*from\s*["']([^"'\n]+)["']/gmu,
    // `import "x"`, for its side effects.
    /^[ \t]*import\s*["']([^"'\n]+)["']/gmu,
    // `import("x")`, wherever it is called.
    /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/gu,
  ])
    for (const match of text.matchAll(pattern))
      found.push({ at: match.index, specifier: match[1]! });
  return found.sort((a, b) => a.at - b.at).map((entry) => entry.specifier);
}
