import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";
import { filesBelow } from "./files.ts";
import { owner, type Dependency, type Module, type OutsideService } from "./source.ts";

function registryHost(image: string): string | undefined {
  if (/[$`{}]/.test(image)) return undefined;
  const first = image.split("/")[0]!;
  return image.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")
    ? first.split(":")[0] : "registry-1.docker.io";
}

// These checks inspect declared images, action references and literal shell/SDK
// inputs. They never run a shell or trace general program execution.
export function pipelineDependencies(root: string, modules: Module[], services: OutsideService[]): {
  dependencies: Dependency[]; errors: string[];
} {
  const dependencies: Dependency[] = [], errors: string[] = [];
  const selected = [...filesBelow(join(root, "containers")).filter(file => file.endsWith("/Dockerfile")),
    ...filesBelow(join(root, ".github/workflows")).filter(file => /\.ya?ml$/.test(file))];
  for (const path of selected) {
    const file = relative(root, path).replaceAll("\\", "/");
    const caller = owner(file, modules);
    if (!caller) { errors.push(`Unmodelled execution source: ${file}`); continue; }
    const report = (message: string) => errors.push(`${file}: ${message}`);
    const add = (service: OutsideService, evidence: string) =>
      dependencies.push({ source: caller.id, target: service.id, evidence: `${file}: ${evidence}` });
    const host = (value: string) => {
      const service = services.find(service => service.hosts.some(candidate =>
        value === candidate || candidate.startsWith("*.") && value.endsWith(candidate.slice(1))));
      if (service) add(service, value); else report(`Unmodelled outside host: ${value}`);
    };
    const sdk = (name: string) => {
      const service = services.find(service => service.sdks.some(candidate => name === candidate || name.startsWith(candidate + "/")));
      if (service) add(service, name);
      else if (!caller.libraries.some(candidate => name === candidate || name.startsWith(candidate + "/"))) report(`Unmodelled SDK or library: ${name}`);
    };
    const image = (value: string) => {
      const registry = registryHost(value);
      if (!registry) report("Container image needs a statically known registry"); else host(registry);
    };
    const shell = (text: string) => {
      for (const match of text.matchAll(/https?:\/\/[^\s'"`<>]+/g)) {
        const authority = /^https?:\/\/([^/]+)/.exec(match[0])?.[1];
        if (!authority || /[$`{}]/.test(authority)) { report("Outside URL has a dynamic host"); continue; }
        try { host(new URL(match[0]).hostname); } catch { report("Outside URL has an unsupported host"); }
      }
      for (const match of text.matchAll(/\b(?:from\s+|import\s+|(?:import|require)\s*\(\s*)['"]([^'"]+)['"]/g)) {
        const name = match[1]!;
        if (name.startsWith(".")) continue;
        if (name.startsWith("node:") && !["node:http", "node:https", "node:http2", "node:net", "node:tls"].includes(name)) continue;
        sdk(name);
      }
      if (/\bpython[\d.]*\s+-c\b/.test(text)) report("Inline Python needs a checked source file");
      for (const match of text.matchAll(/(?:^|[;&|\n])\s*(?:curl|wget)\b([^;&|\n]*)/g)) {
        const destination = /https?:\/\/[^\s'"`]+/.exec(match[1]!);
        if (!destination) report("Shell download needs a literal URL with a statically known host");
      }
      if (/\b(?:npm|bun)\s+(?:install|add|ci)\b/.test(text)) sdk("package:npm");
      if (/\bapk\s+add\b/.test(text)) sdk("package:apk");
      for (const match of text.matchAll(/\bdocker\s+(?:pull|push)\s+([^\s;&|]+)/g)) image(match[1]!);
    };
    const text = readFileSync(path, "utf8");
    if (file.endsWith("/Dockerfile")) {
      const stages = new Set<string>();
      for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
        const line = raw.trim();
        const from = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
        if (from) {
          if (from[1] !== "scratch" && !stages.has(from[1]!.toLowerCase())) image(from[1]!);
          if (from[2]) stages.add(from[2].toLowerCase());
        }
        const copied = /^COPY\s+--from=(\S+)/i.exec(line);
        if (copied && !stages.has(copied[1]!.toLowerCase()) && !/^\d+$/.test(copied[1]!)) image(copied[1]!);
        if (/^(?:RUN|ADD)\s/i.test(line)) shell(line.replace(/^\w+\s+/, ""));
      }
    } else {
      const document = parseDocument(text, { uniqueKeys: true });
      if (document.errors.length) { report("Invalid workflow YAML"); continue; }
      const visit = (value: unknown, key = ""): void => {
        if (typeof value === "string") {
          if (key === "uses") {
            if (value.startsWith("docker://")) image(value.slice(9));
            else if (value.startsWith("./")) return;
            else if (/^[\w.-]+\/[\w./-]+@[^\s]+$/.test(value)) host("github.com");
            else report("Action reference needs a statically known source");
          } else if (key === "image" || key === "container") image(value);
          else shell(value);
        } else if (Array.isArray(value)) value.forEach(item => visit(item, key));
        else if (value && typeof value === "object")
          Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
      };
      visit(document.toJSON());
    }
  }
  return { dependencies, errors: [...new Set(errors)] };
}
