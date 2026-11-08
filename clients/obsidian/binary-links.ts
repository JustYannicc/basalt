import { safePath } from "./types.ts";
export function linkedAttachments(
  note: string,
  links: readonly string[],
  available: ReadonlySet<string>,
) {
  const result = new Set<string>(),
    parent = note.split("/").slice(0, -1);
  for (const raw of links) {
    let link = raw.split("#")[0]?.split("|")[0] ?? "";
    try {
      link = decodeURIComponent(link);
    } catch {
      continue;
    }
    if (!link || /^[a-z][a-z0-9+.-]*:/iu.test(link)) continue;
    const normalized = (parts: readonly string[]) => {
      const stack: string[] = [];
      for (const part of parts) {
        if (part === "..") stack.pop();
        else if (part && part !== ".") stack.push(part);
      }
      return stack.join("/");
    };
    const options = [normalized([...parent, ...link.split("/")]), normalized(link.split("/"))];
    const exact = options.find((path) => safePath(path) && available.has(path));
    if (exact) {
      result.add(exact);
      continue;
    }
    const matches = [...available].filter((path) => path === link || path.endsWith(`/` + link));
    if (matches.length === 1) result.add(matches[0]!);
  }
  return [...result];
}
