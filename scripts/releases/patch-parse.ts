// Parses carried patches the way `git apply` reads them, into per-file sections whose body
// lines keep their patch prefixes and whose extended headers become `#`-prefixed lines.

/** `moved` holds `rename`/`copy` names, which `git apply` uses for the file. */
export type Section = { a: string; b: string; body: string[]; opaque?: string; moved?: string[] };

export const fileHeader = /^diff --git a\/(\S+) b\/(\S+)$/;
const extendedHeader = /^(?:index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?|(?:old|new) mode [0-7]{6}|(?:new|deleted) file mode [0-7]{6}|(?:dis)?similarity index \d{1,3}%|(?:rename|copy) (?:from|to) \S+)$/;
export const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const binaryPayload = /^(?:(?:literal|delta) \d+|[A-Za-z][0-9A-Za-z!#$%&()*+;<=>?@^_`{|}~-]*|)$/;

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

export const devNull = "/dev/null";

/** A traditional header's path after `git apply`'s default `-p1`; `undefined` when it has none. */
export function traditionalName(line: string | undefined, prefix: string): string | undefined {
  if (!line?.startsWith(prefix)) return undefined;
  const name = line.slice(prefix.length).split("\t")[0]!;
  if (name === devNull) return devNull;
  return /^[^/\s]+\/(\S+)$/.exec(name)?.[1];
}

export function groupByFile(sections: Section[]): Map<string, Section> {
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
