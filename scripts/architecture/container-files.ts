import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

// Deliberately bounded to ordinary COPYs. Unsupported context selection must fail
// rather than silently omit an input from the fingerprint or runtime scan.
function tree(path: string, context: string): string[] {
  const actual = realpathSync(path);
  const physicalContext = realpathSync(context);
  const offset = relative(physicalContext, actual);
  if (offset === ".." || offset.startsWith("../") || isAbsolute(offset))
    throw new Error(`Docker COPY escapes context: ${relative(context, path)}`);
  if (lstatSync(path).isSymbolicLink()) throw new Error("Unsupported Docker COPY symlink");
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).sort().flatMap(name => tree(join(path, name), context));
}

function words(text: string): string[] {
  const result: string[] = [];
  const pattern = /"([^"\\]*)"|'([^']*)'|([^\s"'\\]+)/gy;
  let offset = 0;
  while (offset < text.length) {
    if (/\s/.test(text[offset]!)) { offset++; continue; }
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match) throw new Error("Unsupported Docker COPY quoting or escaping");
    result.push(match[1] ?? match[2] ?? match[3]!);
    offset = pattern.lastIndex;
  }
  return result;
}

function copies(context: string): { inputs: string[]; runtime: string[] } {
  context = resolve(context);
  const dockerfile = join(context, "Dockerfile");
  const lines = readFileSync(dockerfile, "utf8").replace(/\\\r?\n/g, " ").split(/\r?\n/);
  const stages: { name?: string; files: Set<string> }[] = [];
  const inputs = new Set([dockerfile]);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(\w+)\s+(.+)$/.exec(line);
    if (!match) throw new Error(`Unsupported Docker instruction at line ${index + 1}`);
    const instruction = match[1]!.toUpperCase();
    let body = match[2]!;
    if (instruction === "FROM") {
      const tokens = words(body).filter(token => !token.startsWith("--platform="));
      if (!tokens[0] || tokens[0].includes("$")) throw new Error("Unresolvable Docker FROM base");
      const base = stages.find(stage => stage.name?.toLowerCase() === tokens[0]?.toLowerCase());
      stages.push({ name: tokens[1]?.toUpperCase() === "AS" ? tokens[2] : undefined, files: new Set(base?.files) });
      continue;
    }
    if (instruction === "ADD") throw new Error("Unsupported Docker ADD; use explicit COPY context inputs");
    if (instruction !== "COPY") continue;
    const stage = stages.at(-1);
    if (!stage) throw new Error("Docker COPY appears before FROM");
    let artifact = false;
    while (body.startsWith("--")) {
      const flag = /^(--[\w-]+)(?:=([^\s]+))?\s+/.exec(body);
      if (!flag) throw new Error("Unsupported Docker COPY flag");
      if (flag[1] === "--from" && flag[2]) artifact = true;
      else if (!["--chown", "--chmod", "--link"].includes(flag[1]!))
        throw new Error(`Unsupported Docker COPY flag: ${flag[1]}`);
      body = body.slice(flag[0].length);
    }
    if (artifact) continue;
    const tokens: unknown = body.startsWith("[") ? JSON.parse(body) : words(body);
    if (!Array.isArray(tokens) || tokens.length < 2 || tokens.some(token => typeof token !== "string"))
      throw new Error("Unsupported Docker COPY sources");
    for (const source of (tokens as string[]).slice(0, -1)) {
      if (!source || /[$*?\[\]{}]/.test(source) || isAbsolute(source) || source.split(/[\\/]/).includes(".."))
        throw new Error(`Unresolvable Docker COPY context path: ${source}`);
      const path = resolve(context, source);
      if (!existsSync(path)) throw new Error(`Missing Docker COPY context path: ${source}`);
      for (const file of tree(path, context)) { inputs.add(file); stage.files.add(file); }
    }
  }
  if (!stages.length) throw new Error("Dockerfile has no FROM stage");
  // Ignore rules can change COPY ownership. Require explicit sources until their
  // semantics are supported, while still including the rules in the digest.
  if (existsSync(join(context, ".dockerignore"))) {
    const ignore = readFileSync(join(context, ".dockerignore"), "utf8");
    if (ignore.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith("#")))
      throw new Error("Unsupported Docker context ignore rules");
    inputs.add(join(context, ".dockerignore"));
  }
  return { inputs: [...inputs].sort(), runtime: [...stages.at(-1)!.files].sort() };
}

export function containerInputs(context: string): string[] { return copies(context).inputs; }
export function containerRuntimeFiles(context: string): string[] { return copies(context).runtime; }
