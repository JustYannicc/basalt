// Finds the template literals (such as sql`...` migration statements) around changed lines in a
// hunk image. A hunk shows only part of a file, so whether its first backtick opens or closes a
// template is inferred from the code around it; when that is unclear both readings count. A hunk
// with no backtick that reads like SQL may sit inside a template whose ends are out of view.

/** One template literal's visible lines; `bounded` when both its backticks are visible. */
export type TemplateBlock = { lines: string[]; bounded: boolean };

// SQL words followed by an operand, not names such as `.join(`, `create:`, `"create"` or `values: [`.
const sqlWords = /(?<![.\w"'/$-])(?:select|insert\s+into|update\s+\S+\s+set|delete\s+from|where|join|values|returning|on\s+conflict|create|alter|drop|grant|revoke)\b(?=\s+[\w"*(${])/i;

/** Template literals in `image` (one side of a hunk) that contain any line in `changed`. */
export function templateBlocks(image: string[], changed: Set<number>): TemplateBlock[] {
  if (!changed.size) return [];
  const outside = toggles(image, false);
  const first = outside.findIndex((positions) => positions.length > 0);
  if (first < 0)
    return image.some((line) => !/^\s*\/\*/.test(line) && !isComment(line) && sqlWords.test(line)) ? [{ lines: image, bounded: false }] : [];
  const kind = firstBacktick(image[first]!, outside[first]![0]!);
  const readings = kind === "open" ? [false] : kind === "close" ? [true] : [false, true];
  const changedLines = [...changed];
  const blocks = new Map<string, TemplateBlock>();
  for (const startsInside of readings) {
    let open = startsInside;
    let start = startsInside ? -1 : 0;
    const spans: Array<[number, number, boolean]> = [];
    (startsInside ? toggles(image, true) : outside).forEach((positions, line) => {
      for (let tick = 0; tick < positions.length; tick++) {
        if (!open) start = line;
        else spans.push([start, line, start >= 0]);
        open = !open;
      }
    });
    if (open) spans.push([start, image.length - 1, false]);
    for (const [from, to, closed] of spans) {
      const lineFrom = Math.max(from, 0);
      if (!changedLines.some((line) => line >= lineFrom && line <= to)) continue;
      blocks.set(`${from}:${to}`, { lines: image.slice(lineFrom, to + 1), bounded: closed });
    }
  }
  return [...blocks.values()];
}

const isComment = (line: string) => /^\s*(?:\/\/|\*)/.test(line);

type Frame = { kind: "template" } | { kind: "expression"; depth: number };

/**
 * Positions of the backticks that open or close an outermost template, per line, for a reading
 * that starts inside or outside one. Templates nested in `${...}` do not count. Outside a
 * template, quoted strings and comments are skipped.
 */
function toggles(image: string[], startsInside: boolean): number[][] {
  const stack: Frame[] = startsInside ? [{ kind: "template" }] : [];
  let blockComment = false;
  return image.map((line) => {
    const positions: number[] = [];
    let quote: string | undefined;
    if (!stack.length && isComment(line)) return positions;
    for (let index = 0; index < line.length; index++) {
      const char = line[index]!;
      const top = stack.at(-1);
      if (blockComment) {
        if (char === "*" && line[index + 1] === "/") { blockComment = false; index++; }
      } else if (char === "\\") index++;
      else if (top?.kind === "template") {
        if (char === "`") { stack.pop(); if (!stack.length) positions.push(index); }
        else if (char === "$" && line[index + 1] === "{") { stack.push({ kind: "expression", depth: 0 }); index++; }
      } else if (quote) { if (char === quote) quote = undefined; }
      else if (char === "\"" || char === "'") quote = char;
      else if (char === "`") { if (!stack.length) positions.push(index); stack.push({ kind: "template" }); }
      else if (char === "/" && line[index + 1] === "/") break;
      else if (char === "/" && line[index + 1] === "*") { blockComment = true; index++; }
      else if (top?.kind === "expression" && char === "{") top.depth++;
      else if (top?.kind === "expression" && char === "}") { if (top.depth) top.depth--; else stack.pop(); }
    }
    return positions;
  });
}

/** Whether a backtick can open a template (after a tag or an operator) or close one. */
function firstBacktick(line: string, position: number): "open" | "close" | "either" {
  const before = line.slice(0, position);
  const after = line.slice(position + 1);
  const expectsExpression = /(?:[(=:,[{?!&|+]|=>|\breturn)\s*$/.test(before);
  // A backtick first on its line followed by text starts an argument; a typed tag such as
  // sql<Row>` ends in `>`. A closer is followed by punctuation, `as`, `satisfies` or nothing.
  const canOpen = (expectsExpression || /[\w$>)\]]\s*$/.test(before) || !/\S/.test(before)) && !/^\s*[;),\]}]/.test(after);
  const canClose = !expectsExpression && /^\s*(?:[;),.\]}:?+\-*/%&|<>=!]|as\b|satisfies\b|$)/.test(after);
  return canOpen && !canClose ? "open" : canClose && !canOpen ? "close" : "either";
}
