// A disable comment would hide a finding from the baseline, so the check reads each one the way
// oxlint does and allows only a `//` comment that names upstream rules and nothing else.
const OWNED_RULE = /^(?:basalt|landmines-[\w-]+|anti-slop(?:-effect)?)\//u;
// A `//` comment ends at any JavaScript line terminator, not only \n.
const LINE_END = /\r\n|[\n\r\u2028\u2029]/u;

/**
 * The refused disable comments in one file. `native` holds the bare names of the built-in rules
 * the owned configuration enables, which are owned rules too under any prefix.
 */
export function directiveProblems(
  file: string,
  text: string,
  native: ReadonlySet<string> = new Set(),
) {
  const problems: string[] = [];
  for (const match of text.matchAll(/(?:oxlint|eslint)-disable/gu)) {
    const lines = text.slice(0, match.index).split(LINE_END);
    const before = lines.at(-1)!;
    const after = text.slice(match.index + match[0].length).split(LINE_END)[0]!;
    const names = after
      .replace(/^(?:-next-line|-line)?/u, "")
      .replace(/--.*$/u, "")
      .split(/[\s,]+/u)
      .filter(Boolean);
    // oxlint splits names on Unicode whitespace such as U+0085, which \s leaves inside a name, so
    // only plain rule names count; anything else, a wildcard included, is refused.
    const upstreamOnly =
      /^\s*\/\/\s*$/u.test(before) &&
      names.length > 0 &&
      names.every((name) => /^[@\w./-]+$/u.test(name)) &&
      !names.some((name) => OWNED_RULE.test(name) || native.has(name.split("/").at(-1)!));
    if (upstreamOnly) continue;
    problems.push(
      `${file}:${lines.length} has a disable comment that is not a single \`//\` comment naming only upstream rules. Owned rules take no disable comments: fix the finding, or for a reasoned exception use scripts/owned-lint/allowlist.json.`,
    );
  }
  return problems;
}
