// Finds what two versions of a carried patch change in the deployed upstream source, from the
// patch text alone. The pinned upstream is the same on both sides, so a file's effective content
// differs only where its patch lines differ. Anything this cannot see stays opaque.

/** One upstream file whose effective content differs, with the patch lines that show it. */
export type FileChange = {
  /** Display name; nested files read `outer.patch > inner/path`. */
  path: string;
  /** Paths the path rules judge: the file's a/ and b/ names, or a nested patch's inner names. */
  rulePaths: string[];
  /** Changed patch lines and their neighbours, without the patch's own line prefixes. */
  lines: string[];
  /** Why part of this change cannot be seen, when it cannot. */
  opaque?: string;
};

export type PatchDelta = { ok: true; files: FileChange[] } | { ok: false; reason: string };

/** `moved` holds `rename`/`copy` names, which `git apply` uses for the file. */
type Section = { a: string; b: string; body: string[]; opaque?: string; moved?: string[] };

const fileHeader = /^diff --git a\/(\S+) b\/(\S+)$/;
const extendedHeader = /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?|(?:old|new) mode [0-7]{6}|(?:new|deleted) file mode [0-7]{6}|(?:dis)?similarity index \d{1,3}%|(?:rename|copy) (?:from|to) \S+)$/;
const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const nestedPatchPath = /\.(?:patch|diff)$/;
const nestedOpaque = /^(?:(?:rename|copy) (?:from|to) |deleted file mode |Binary files |GIT binary patch$)/;
const binaryPayload = /^(?:(?:literal|delta) \d+|[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]*|)$/;
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
      ...(opaque ? { opaque } : {}),
    });
  }
  return { ok: true, files };
}

/**
 * Parses what `git apply` accepts: Git sections (`diff --git`) and traditional unified sections
 * (`---`/`+++` names, stripped of one leading directory). Parsing is strict; any line it does not
 * understand makes the whole patch unreadable.
 */
export function parsePatch(text: string): Section[] | string {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const sections: Section[] = [];
  let index = 0;
  const fail = (message: string) => `line ${index + 1}: ${message}`;
  while (index < lines.length) {
    const header = fileHeader.exec(lines[index]!);
    let section: Section;
    if (header) {
      section = { a: header[1]!, b: header[2]!, body: [] };
      index++;
      while (index < lines.length && extendedHeader.test(lines[index]!)) {
        const line = lines[index++]!;
        if (!line.startsWith("index ")) section.body.push(`#${line}`);
        const moved = /^(?:rename|copy) (?:from|to) (\S+)$/.exec(line);
        if (moved) {
          section.opaque ??= "renamed or copied file";
          section.moved = [...section.moved ?? [], moved[1]!];
        }
      }
      if (lines[index]?.startsWith("Binary files ") || lines[index] === "GIT binary patch") {
        section.opaque = "binary file";
        const literal = lines[index] === "GIT binary patch";
        section.body.push(`#${lines[index++]}`);
        // Only `literal`/`delta` blocks of base85 lines follow, each ended by a blank line.
        while (literal && index < lines.length && binaryPayload.test(lines[index]!)) section.body.push(`#${lines[index++]}`);
        sections.push(section);
        continue;
      }
      if (lines[index]?.startsWith("--- ")) {
        if (lines[index] !== `--- a/${section.a}` && lines[index] !== "--- /dev/null") return fail("old file name does not match its header");
        index++;
        if (lines[index] !== `+++ b/${section.b}` && lines[index] !== "+++ /dev/null") return fail("new file name does not match its header");
        index++;
      }
    } else {
      const oldName = traditionalName(lines[index], "--- ");
      const newName = traditionalName(lines[index + 1], "+++ ");
      if (oldName === undefined || newName === undefined || oldName === devNull && newName === devNull)
        return fail("expected a `diff --git` or `---`/`+++` file header");
      section = {
        a: oldName === devNull ? newName : oldName,
        b: newName === devNull ? oldName : newName,
        body: [...oldName === devNull ? ["#new file"] : [], ...newName === devNull ? ["#deleted file"] : []],
      };
      index += 2;
      if (!lines[index]?.startsWith("@@")) return fail("file header without a hunk");
    }
    while (index < lines.length && lines[index]!.startsWith("@@")) {
      const hunk = hunkHeader.exec(lines[index]!);
      if (!hunk) return fail("malformed hunk header");
      let oldLeft = Number(hunk[2] ?? 1);
      let newLeft = Number(hunk[4] ?? 1);
      section.body.push(lines[index++]!);
      while (oldLeft > 0 || newLeft > 0) {
        const line = lines[index];
        if (line === undefined) return fail("hunk ends early");
        const tag = line === "" ? " " : line[0];
        if (tag === " ") { oldLeft--; newLeft--; }
        else if (tag === "-") oldLeft--;
        else if (tag === "+") newLeft--;
        else if (tag !== "\\") return fail("hunk line has no ' ', '+', '-' or '\\' prefix");
        if (oldLeft < 0 || newLeft < 0) return fail("hunk is longer than its header");
        section.body.push(line === "" ? " " : line);
        index++;
      }
      if (lines[index]?.startsWith("\\")) section.body.push(lines[index++]!);
    }
    const hasHunk = section.body.some((line) => line.startsWith("@@"));
    if (!hasHunk && section.body.some((line) => line.startsWith("#deleted file mode")))
      section.opaque ??= "deleted file without visible content";
    sections.push(section);
  }
  return sections;
}

const devNull = "/dev/null";

/** A traditional header's path after `git apply`'s default `-p1`; `undefined` when it has none. */
function traditionalName(line: string | undefined, prefix: string): string | undefined {
  if (!line?.startsWith(prefix)) return undefined;
  const name = line.slice(prefix.length).split("\t")[0]!;
  if (name === devNull) return devNull;
  return /^[^/\s]+\/(\S+)$/.exec(name)?.[1];
}

function groupByFile(sections: Section[]): Map<string, Section> {
  const files = new Map<string, Section>();
  for (const section of sections) {
    const key = `${section.a}\0${section.b}`;
    const existing = files.get(key);
    if (!existing) files.set(key, { ...section, body: [...section.body] });
    else {
      existing.body.push(...section.body);
      existing.opaque ??= section.opaque;
      if (section.moved) existing.moved = [...existing.moved ?? [], ...section.moved];
    }
  }
  return files;
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
      change = attribution === undefined
        ? { path: outer, rulePaths: [outer], lines: [] }
        : attribution === "unknown"
          ? { path: outer, rulePaths: [outer], lines: [], opaque: "nested patch change outside a visible file header" }
          : attribution.length === 0
            ? { path: `${outer} (preamble)`, rulePaths: [], lines: [] }
            : { path: `${outer} > ${attribution.at(-1)}`, rulePaths: attribution, lines: [] };
      groups.set(key, change);
    }
    return change;
  };
  for (const [body, changed] of versions) {
    const attributions = attribute(body);
    for (const [index, text] of scanLines(body, changed)) {
      const line = body[index]!;
      // Only added or removed lines edit the nested patch; a context line changes nothing in it.
      const edit = line[0] === "+" || line[0] === "-";
      const attribution = attributions[index] === "unknown" && !edit ? undefined : attributions[index];
      const change = group(attribution);
      change.lines.push(text);
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
    const update = (side: Attribution): Attribution =>
      header ? [...new Set([header[1]!, header[2]!])]
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
