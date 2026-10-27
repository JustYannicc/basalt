import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { LikeC4 } from "likec4";
import { discoverStackDetails, discoverStackInventory } from "./native-stack.ts";
import { stackFingerprint } from "./fingerprint.ts";
import { hasVendor } from "./language.ts";
import { filesBelow, values } from "./source.ts";

export function deploymentKind(kind: string): string {
  if (/Worker$/.test(kind)) return "worker";
  if (/DurableObject(?:Namespace)?$/.test(kind)) return "durableObject";
  if (/Container$/.test(kind)) return "container";
  if (/Queue$/.test(kind)) return "queue";
  if (/Exec|Build|Dev|Workflow|Monitor|Lifecycle|Resume/.test(kind)) return "workflow";
  if (/Hyperdrive|Volume|ObservabilityDestination|Bucket|Database|Role|Branch|Certificate|Connection|Secret|Random|Token|Dataset|Subdomain|Record|Pages|Tunnel|Application|Domain|Zone|Ruleset/.test(kind)) return "storage";
  throw new Error(`Unclassified deployment kind '${kind}'; map it to a glossary deployment kind`);
}

export async function generateDeployment(root: string): Promise<string> {
  const fingerprint = stackFingerprint(root);
  const architecture = join(root, "architecture");
  const snapshot = discoverStackDetails(root);
  const resources = snapshot.inventory;
  if (resources.length === 0) throw new Error("No stack resources discovered");
  // Stale generated references must not prevent regenerating a renamed element.
  const authored = filesBelow(architecture).filter(path => /\.(c4|likec4)$/.test(path) &&
    !path.startsWith(join(architecture, "gen") + "/") && !path.startsWith(join(architecture, "views") + "/"));
  const workspace = await LikeC4.fromSource(authored.map(path => readFileSync(path, "utf8")).join("\n"), { logger: false });
  try {
    if (workspace.hasErrors()) throw new Error(JSON.stringify(workspace.getErrors()));
    const model = await workspace.computedModel();
    const mappings = new Map<string, { id: string; title: string }>();
    for (const element of model.elements()) {
      for (const resource of values(element.metadata.resources)) {
        if (mappings.has(resource)) throw new Error(`Duplicate resource mapping: ${resource}`);
        mappings.set(resource, { id: element.id, title: element.title });
      }
    }
    const actual = new Set(resources.map(resource => resource.id));
    const stale = [...mappings.keys()].filter(id => !actual.has(id));
    const missing = resources.filter(resource => !mappings.has(resource.id));
    if (stale.length || missing.length) throw new Error(JSON.stringify({ staleMappings: stale, unmodelledResources: missing }, null, 2));
    const lines = [
      "// Generated from the deployment stack. Do not edit.",
      "deployment {",
      '  stage deployed "Declared deployment" {',
      `    metadata { bindings "${snapshot.digest}" }`,
    ];
    const groups = new Map<string, typeof resources>();
    const children = new Map<string, typeof resources>();
    for (const resource of resources.filter(resource => resource.ownerId)) {
      const owner = resources.find(candidate => candidate.id === resource.ownerId);
      if (owner?.kind !== "Worker") throw new Error(`Exported class has no owning worker: ${resource.id}`);
      const owned = children.get(owner.id) ?? [];
      owned.push(resource);
      children.set(owner.id, owned);
    }
    for (const resource of resources.filter(resource => !resource.ownerId)) {
      const id = mappings.get(resource.id)!.id;
      const group = groups.get(id) ?? [];
      group.push(resource);
      groups.set(id, group);
    }
    const details: string[] = [];
    for (const [element, members] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const mapping = mappings.get(members[0]!.id)!;
      const group = `group-${createHash("sha256").update(element).digest("hex").slice(0, 16)}`;
      lines.push(`    zone ${group} ${JSON.stringify(mapping.title)} {`);
      const emitResource = (resource: typeof resources[number], indent: string): void => {
        const target = mappings.get(resource.id)!;
        const candidate = resource.declaredName.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
        const title = /^[A-Za-z][A-Za-z0-9 _-]{0,80}$/.test(candidate) && !hasVendor(candidate)
          ? candidate : target.title;
        lines.push(`${indent}${deploymentKind(resource.kind)} ${resource.id} ${JSON.stringify(title)} {`,
          `${indent}  app = instanceOf ${target.id} {`,
          `${indent}    metadata { resource "${resource.id}" }`, `${indent}  }`);
        for (const child of children.get(resource.id) ?? []) emitResource(child, indent + "  ");
        lines.push(`${indent}}`);
        if (resource.kind === "Worker") details.push(
          `  deployment view worker_${resource.id.replaceAll("-", "_")} {`,
          `    title ${JSON.stringify(`Basalt/Deployment/${mapping.title}/${title}`)}`,
          `    include deployed.${group}.${resource.id}.**`, "    autoLayout TopBottom", "  }");
      };
      for (const resource of members) emitResource(resource, "      ");
      lines.push("    }");
      details.push(`  deployment view deployment_${group.replaceAll("-", "_")} {`,
        `    title ${JSON.stringify(`Basalt/Deployment/${mapping.title}`)}`,
        `    include deployed.${group}.*`, "    autoLayout TopBottom", "  }");
    }
    lines.push("  }", "}", "views {", "  deployment view declared_deployment {",
      '    title "Basalt/Deployment"', "    include deployed.*", "    autoLayout TopBottom", "  }", ...details, "}", "");
    if (stackFingerprint(root) !== fingerprint)
      throw new Error("Source changed during deployment generation; rerun with stable inputs");
    return lines.join("\n");
  } finally { await workspace.dispose(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  if (process.argv.includes("--inventory")) console.log(JSON.stringify(discoverStackInventory(root), null, 2));
  else {
    const output = join(root, "architecture/gen/stack.gen.c4");
    console.log(`Deployment source fingerprint: ${stackFingerprint(root)}`);
    const source = await generateDeployment(root);
    mkdirSync(join(root, "architecture/gen"), { recursive: true });
    writeFileSync(output, source);
    execFileSync(fileURLToPath(new URL("node_modules/.bin/likec4", import.meta.url)), ["format", join(root, "architecture"), "--files", output], { stdio: "inherit" });
  }
}
