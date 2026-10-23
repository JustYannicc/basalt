import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, expect, test } from "vitest";
import { LikeC4 } from "likec4";
import type { $ElementId } from "./gen/model.ts";
import { moduleErrors, sourceDependencies, values } from "./source.ts";
import { glossaryValues, hasVendor, languageErrors } from "./language.ts";
import { discoverStackInventory } from "./native-stack.ts";
import { serviceArchitecture } from "../../src/router.ts";
import { pipelineDependencies } from "./pipeline.ts";

const routerId: $ElementId = "basalt.router";
const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
let workspace: LikeC4;
let model: Awaited<ReturnType<LikeC4["computedModel"]>>;
beforeAll(async () => {
  workspace = await LikeC4.fromWorkspace(`${root}/architecture`, { logger: false });
  expect(workspace.getErrors()).toEqual([]);
  model = await workspace.computedModel();
}, 30_000);
afterAll(() => workspace?.dispose());

const modules = () => [...model.elements()].flatMap(element =>
  values(element.metadata.code).map(code => ({
    id: element.id, code,
    bindings: values(element.metadata.bindings),
    libraries: values(element.metadata.libraries),
    configuration: values(element.metadata.configuration).includes("true"),
    endpointHosts: values(element.metadata.endpointHosts),
  })));

test("deployed resources and deployment instances correspond in both directions", () => {
  const resources = discoverStackInventory(root);
  const mapped = [...model.elements()].flatMap(element =>
    values(element.metadata.resources).map(id => ({ id, element: element.id })));
  expect(mapped.length).toBeGreaterThan(0);
  expect(mapped.map(m => m.id).sort()).toEqual(resources.map(r => r.id).sort());
  expect(new Set(mapped.map(m => m.id)).size).toBe(mapped.length);
  const deployed = new Map([...model.deployment.instances()].map(instance => [values(instance.metadata.resource)[0], instance]));
  for (const resource of resources.filter(resource => resource.ownerId))
    expect(deployed.get(resource.id)?.parent?.parent?.id, resource.id).toBe(deployed.get(resource.ownerId!)?.parent?.id);
  const instances = [...model.deployment.instances()].map(instance => ({
    id: values(instance.metadata.resource)[0], element: instance.element.id,
  }));
  expect(instances.sort((a, b) => a.id!.localeCompare(b.id!)))
    .toEqual(mapped.sort((a, b) => a.id.localeCompare(b.id)));
});

test("outside hosts, SDKs and service bindings have caller relationships", () => {
  const services = [...model.elements()].filter(e => e.isTagged("external") || values(e.metadata.endpointHosts).length).map(element => ({
    id: element.id, hosts: [...values(element.metadata.hosts), ...values(element.metadata.endpointHosts)], sdks: values(element.metadata.sdks),
  }));
  const router = modules().find(module => module.id === routerId);
  expect(router?.bindings.sort()).toEqual(Object.entries(serviceArchitecture).map(([binding, id]) => `${binding}=${id}`).sort());
  const source = sourceDependencies(root, modules(), services);
  const pipeline = pipelineDependencies(root, modules(), services);
  expect([...source.errors, ...pipeline.errors]).toEqual([]);
  const dependencies = [...source.dependencies, ...pipeline.dependencies];
  const relationships = new Set([...model.relationships()].map(r => `${r.source.id}->${r.target.id}`));
  for (const module of modules()) {
    for (const binding of module.bindings) {
      const [name, target] = binding.split("=");
      expect(name && target && model.findElement(target), `${module.id}: ${binding}`).toBeTruthy();
      expect(relationships.has(`${module.id}->${target}`), `${module.id}: ${binding}`).toBe(true);
    }
  }
  expect(dependencies.filter(d => !relationships.has(`${d.source}->${d.target}`))).toEqual([]);
});

test("every owned package and module has code and all cross-module imports have relationships", () => {
  expect(moduleErrors(root, modules())).toEqual([]);
  const { dependencies } = sourceDependencies(root, modules(), []);
  const relationships = new Set([...model.relationships()].map(r => `${r.source.id}->${r.target.id}`));
  const moduleIds = new Set<string>(modules().map(m => m.id));
  expect(dependencies.filter(d => moduleIds.has(d.target) && !relationships.has(`${d.source}->${d.target}`))).toEqual([]);
});

test("every dynamic-view step has a backing model relationship", () => {
  const dynamic = [...model.views()].filter(view => view.isDynamicView());
  expect(dynamic.length).toBeGreaterThan(0);
  for (const view of dynamic) {
    expect([...view.edges()].length, view.id).toBeGreaterThan(0);
    for (const edge of view.edges())
      expect([...edge.relationships("model")].length, `${view.id}: ${edge.id}`).toBeGreaterThan(0);
  }
});

test("kinds, tags and domain language match the glossary", () => {
  const glossary = readFileSync(`${root}/architecture/CONTEXT.md`, "utf8");
  const allowedElements = glossaryValues(glossary, "Element kinds");
  const allowedDeployments = glossaryValues(glossary, "Deployment kinds");
  const allowedTags = glossaryValues(glossary, "Tags");
  expect(Object.keys(model.specification.elements).sort()).toEqual([...allowedElements].sort());
  expect(Object.keys(model.specification.deployments).sort()).toEqual([...allowedDeployments].sort());
  expect(Object.keys(model.specification.tags).sort()).toEqual([...allowedTags].sort());
  for (const forbidden of ["org", "company", "project", "section", "environment"]) {
    expect(allowedElements.has(forbidden), forbidden).toBe(false);
    expect(allowedDeployments.has(forbidden), forbidden).toBe(false);
  }
  for (const element of model.elements()) {
    expect(allowedElements.has(element.kind), element.id).toBe(true);
    expect(element.tags.every(tag => allowedTags.has(tag)), element.id).toBe(true);
    if (element.technology && hasVendor(element.technology)) expect(element.kind, element.id).toBe("adapter");
    if ([...values(element.metadata.hosts), ...values(element.metadata.sdks)].some(hasVendor)) {
      expect(element.kind, element.id).toBe("adapter");
      expect(element.isTagged("external"), element.id).toBe(true);
    }
  }
  for (const node of model.deployment.nodes()) expect(allowedDeployments.has(node.kind), node.id).toBe(true);
  for (const relation of model.relationships()) expect(hasVendor(relation.technology ?? ""), relation.id).toBe(false);
  for (const view of model.views()) {
    for (const node of view.nodes()) {
      if (hasVendor(node.technology ?? "")) expect(node.element?.kind, `${view.id}: ${node.id}`).toBe("adapter");
    }
    for (const edge of view.edges()) expect(hasVendor(edge.technology ?? ""), `${view.id}: ${edge.id}`).toBe(false);
  }
  expect(languageErrors(root)).toEqual([]);
});

test("PRs changing runtime or stack update the architecture in the same PR", () => {
  const base = process.env.ARCHITECTURE_BASE_SHA;
  if (!base) return;
  if (!/^[a-f0-9]{40}$/.test(base)) throw new Error("Invalid architecture comparison commit");
  const changed = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: root, encoding: "utf8" }).trim().split("\n");
  const boundary = changed.some(file => /^(?:src\/|packages\/|containers\/|alchemy\.run\.ts$|upstream\.json$|patches\/)/.test(file));
  if (boundary) expect(changed.some(file => /^architecture\/.+\.(?:c4|likec4|md)$/.test(file))).toBe(true);
});
