// Finds what two versions of a carried patch change in the deployed upstream source, from the
// patch text alone. The pinned upstream is the same on both sides, so a file's effective content
// differs only where its patch lines differ. Anything this cannot see stays opaque.

import { devNull, fileHeader, groupByFile, hunkHeader, parsePatch, traditionalName } from "./patch-parse.ts";
import { templateBlocks, type TemplateBlock } from "./template-blocks.ts";

/** One upstream file whose effective content differs, with the patch lines that show it. */
export type FileChange = {
  /** Display name; nested files read `outer.patch > inner/path`. */
  path: string;
  /** Paths the path rules judge: the file's a/ and b/ names, or a nested patch's inner names. */
  rulePaths: string[];
  /** Changed patch lines and their neighbours, without the patch's own line prefixes. */
  lines: string[];
  /** Only the added or removed lines whose presence differs between the two versions. */
  changed: string[];
  /** Template literals (such as sql`...` statements) that contain a changed line. */
  blocks: TemplateBlock[];
  /** Why part of this change cannot be seen, when it cannot. */
  opaque?: string;
};

export type PatchDelta = { ok: true; files: FileChange[] } | { ok: false; reason: string };

const nestedPatchPath = /\.(?:patch|diff)$/;
const nestedOpaque = /^(?:(?:rename|copy) (?:from|to) |deleted file mode |Binary files |GIT binary patch$)/;
/** Files whose backticks delimit template literals. */
const scriptPath = /\.(?:[cm]?[jt]sx?)$/;
const window = 3;
const maxTableCells = 16_000_000;

/** The upstream files whose effective content differs between two versions of a carry. */
export function patchDelta(before: string | null, after: string | null): PatchDelta {
  if (before === null || after === null) return { ok: false, reason: "patch is not UTF-8 text" };
  const oldSections = parsePatch(before);
  if (typeof oldSections === "string") return { ok: false, reason: oldSections };
  const newSections = parsePatch(after);
  if (typeof newSections === "string") return { ok: false, reason: newSections };
  const oldFiles = groupByFile(oldSections);
  const newFiles = groupByFile(newSections);
  const files: FileChange[] = [];
  for (const key of [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort()) {
    const oldFile = oldFiles.get(key);
    const newFile = newFiles.get(key);
    const oldBody = oldFile?.body ?? [];
    const newBody = newFile?.body ?? [];
    if (oldFile && newFile && sameLines(oldBody, newBody) && oldFile.opaque === newFile.opaque) continue;
    const { a, b } = (oldFile ?? newFile)!;
    const opaque = oldFile?.opaque ?? newFile?.opaque;
    const moved = [...oldFile?.moved ?? [], ...newFile?.moved ?? []];
    const [oldChanged, newChanged] = changedIndices(oldBody, newBody);
    if (nestedPatchPath.test(b) && !opaque) {
      files.push(...nestedChanges(b, [[oldBody, oldChanged], [newBody, newChanged]]));
      continue;
    }
    files.push({
      path: b,
      rulePaths: [...new Set([a, b, ...moved])],
      lines: [...scanLines(oldBody, oldChanged), ...scanLines(newBody, newChanged)].map(([, text]) => text),
      changed: [...editTexts(oldBody, oldChanged), ...editTexts(newBody, newChanged)],
      blocks: scriptPath.test(b) ? [...blocksAround(oldBody, oldChanged), ...blocksAround(newBody, newChanged)] : [],
      ...(opaque ? { opaque } : {}),
    });
  }
  return { ok: true, files };
}

/** Indices of lines outside a longest common subsequence; over the size cap, the whole middle. */
function changedIndices(x: string[], y: string[]): [Set<number>, Set<number>] {
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length;
  let endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const n = endX - start;
  const m = endY - start;
  const changedX = new Set<number>();
  const changedY = new Set<number>();
  if ((n + 1) * (m + 1) > maxTableCells) {
    for (let i = start; i < endX; i++) changedX.add(i);
    for (let j = start; j < endY; j++) changedY.add(j);
    return [changedX, changedY];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i * width + j] = x[start + i] === y[start + j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[start + i] === y[start + j]) { i++; j++; }
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) changedX.add(start + i++);
    else changedY.add(start + j++);
  }
  while (i < n) changedX.add(start + i++);
  while (j < m) changedY.add(start + j++);
  return [changedX, changedY];
}

/** Each changed line with its neighbours, as `[changed line index, text without prefix]`. */
function scanLines(body: string[], changed: Set<number>): Array<[number, string]> {
  const out: Array<[number, string]> = [];
  for (const index of [...changed].sort((left, right) => left - right))
    for (let near = Math.max(0, index - window); near <= Math.min(body.length - 1, index + window); near++)
      out.push([index, lineText(body[near]!)]);
  return out;
}

const isEdit = (line: string) => line[0] === "+" || line[0] === "-";

function editTexts(body: string[], changed: Set<number>): string[] {
  return [...changed].sort((left, right) => left - right)
    .filter((index) => isEdit(body[index]!)).map((index) => body[index]!.slice(1));
}

/** Template literals around changed edit lines, read in each hunk's old and new image. */
function blocksAround(body: string[], changed: Set<number>): TemplateBlock[] {
  const blocks: TemplateBlock[] = [];
  let hunk: number[] = [];
  const flush = () => {
    for (const side of ["-", "+"]) {
      const image = hunk.filter((index) => body[index]![0] === " " || body[index]![0] === side);
      // When any line of a hunk changed, its edits may have moved, so all of them count.
      const touched = hunk.some((index) => changed.has(index));
      const edits = new Set(image.flatMap((index, position) => touched && isEdit(body[index]!) ? [position] : []));
      blocks.push(...templateBlocks(image.map((index) => body[index]!.slice(1)), edits));
    }
    hunk = [];
  };
  body.forEach((line, index) => {
    if (line.startsWith("@@") || line.startsWith("#")) flush();
    else if (line[0] !== "\\") hunk.push(index);
  });
  flush();
  return blocks;
}

function lineText(line: string): string {
  if (line.startsWith("@@")) return hunkHeader.exec(line)?.[5] ?? "";
  return line.slice(1);
}

type Attribution = string[] | "unknown";

/**
 * A nested patch (such as a dependency patch the carry edits) changes the files named by its own
 * `diff --git` headers, which appear inside the carry as prefixed lines. A changed line belongs
 * to the nearest such header above it in the same outer hunk; without one it is opaque.
 */
function nestedChanges(outer: string, versions: Array<[string[], Set<number>]>): FileChange[] {
  const groups = new Map<string, FileChange>();
  const group = (attribution: Attribution | undefined): FileChange => {
    const key = attribution === undefined ? "outer" : attribution === "unknown" ? "unknown" : `file\0${attribution.join("\0")}`;
    let change = groups.get(key);
    if (!change) {
      // The outer name stays a rule path: it names the dependency, such as better-auth@x.patch.
      const empty = (path: string, rulePaths: string[]): FileChange => ({ path, rulePaths: [outer, ...rulePaths], lines: [], changed: [], blocks: [] });
      change = attribution === undefined ? empty(outer, [])
        : attribution === "unknown" ? { ...empty(outer, []), opaque: "nested patch change outside a visible file header" }
          : attribution.length === 0 ? empty(`${outer} (preamble)`, [])
            : empty(`${outer} > ${attribution.at(-1)}`, attribution);
      groups.set(key, change);
    }
    return change;
  };
  for (const [body, changed] of versions) {
    const attributions = attribute(body);
    const counted = new Set<number>();
    for (const [index, text] of scanLines(body, changed)) {
      const line = body[index]!;
      // Only added or removed lines edit the nested patch; a context line changes nothing in it.
      const edit = isEdit(line);
      const attribution = attributions[index] === "unknown" && !edit ? undefined : attributions[index];
      const change = group(attribution);
      change.lines.push(text);
      if (edit && !counted.has(index)) {
        counted.add(index);
        change.changed.push(line.slice(1));
      }
      if (!edit || !Array.isArray(attribution)) continue;
      if (attribution.some((path) => nestedPatchPath.test(path)))
        change.opaque ??= "patch nested more than one level deep";
      if (nestedOpaque.test(line.slice(1)))
        change.opaque ??= "nested binary, renamed or copied file";
    }
  }
  return [...groups.values()];
}

/** Which nested file each body line belongs to; `undefined` for the outer patch's own structure. */
function attribute(body: string[]): Array<Attribution | undefined> {
  let oldSide: Attribution = "unknown";
  let newSide: Attribution = "unknown";
  return body.map((line) => {
    if (line.startsWith("#") || line.startsWith("\\")) return undefined;
    const hunk = hunkHeader.exec(line);
    if (hunk) {
      oldSide = Number(hunk[1]) <= 1 ? [] : "unknown";
      newSide = Number(hunk[3]) <= 1 ? [] : "unknown";
      return undefined;
    }
    const content = line.slice(1);
    const header = fileHeader.exec(content);
    // A `---`/`+++` line may start a traditional section or be an edited `-- ` line, so it only
    // adds its name to what the line could belong to.
    const loose = header ? undefined : traditionalName(content, "--- ") ?? traditionalName(content, "+++ ");
    // A header this cannot read leaves the following lines without a known file.
    const unreadable = !header && content.startsWith("diff --git ");
    const update = (side: Attribution): Attribution =>
      unreadable ? "unknown"
        : header ? [...new Set([header[1]!, header[2]!])]
        : loose && loose !== devNull && side !== "unknown" ? [...new Set([...side, loose])]
          : side;
    if (line[0] === "-") return oldSide = update(oldSide);
    if (line[0] === "+") return newSide = update(newSide);
    oldSide = update(oldSide);
    newSide = update(newSide);
    if (oldSide === "unknown" || newSide === "unknown") return "unknown";
    return [...new Set([...oldSide, ...newSide])];
  });
}

function sameLines(x: string[], y: string[]): boolean {
  return x.length === y.length && x.every((line, index) => line === y[index]);
}
