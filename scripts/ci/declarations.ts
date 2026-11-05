import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { heavyJobs } from "./areas.ts";
import { frozenInputMatcher, isRelativeInput } from "./inputs.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const targets = ["self-host", "local", "cloud"] as const;
const modes = [
  "managed",
  "rate-limited",
  "rolled-back",
  "oauth-proxy-preview",
  "manual-cron",
] as const;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a declaration object");
  return value as Record<string, unknown>;
};
const text = (value: unknown) => {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Expected nonempty declaration text");
  return value;
};
const strings = (value: unknown) => {
  if (!Array.isArray(value)) throw new Error("Expected a declaration list");
  return value.map(text);
};
const choice = <T extends string>(value: unknown, choices: readonly T[]): T => {
  const result = text(value);
  if (!choices.includes(result as T)) throw new Error("Unknown declaration choice: " + result);
  return result as T;
};
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const escape = (title: string) => title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function readDeclarations(root = repository) {
  let matchesInput: ReturnType<typeof frozenInputMatcher> | undefined;
  const manualTargets = Object.fromEntries(
    Object.entries(
      record(record(json(join(root, "scripts/ci/inherited-tests.json"))).manualTargets ?? {}),
    ).map(([key, value]) => {
      const manual = record(value);
      return [
        key,
        {
          file: text(manual.file),
          target: choice(manual.target, targets),
          runtime: choice(manual.runtime, ["attached"] as const),
          reason: text(manual.reason),
          command: text(manual.command),
        },
      ];
    }),
  );
  const groups = Object.fromEntries(
    Object.entries(record(json(join(root, "scripts/ci/e2e-groups.json")))).map(([id, value]) => {
      if (!/^[a-z0-9:-]+$/.test(id)) throw new Error("Invalid e2e group: " + id);
      const group = record(value);
      const job = text(group.job);
      if (!heavyJobs.includes(job) && job !== "fast")
        throw new Error("Unknown declared job: " + job);
      return [
        id,
        {
          job,
          target: choice(group.target, targets),
          mode: choice(group.mode, modes),
          matrix: group.matrix === true,
          command: group.command === undefined ? undefined : text(group.command),
        },
      ];
    }),
  );
  const files = Object.fromEntries(
    readdirSync(join(root, "e2e/plans"), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => {
        if (!entry.isFile() || !/^[a-z0-9-]+\.spec\.ts\.json$/.test(entry.name))
          throw new Error("Invalid per-file declaration: " + entry.name);
        const file = entry.name.slice(0, -5);
        const source = record(json(join(root, "e2e/plans", entry.name)));
        if (
          Object.keys(source).some(
            (key) =>
              !["scenarios", "runs", "inherited", "inputs", "config", "fixture"].includes(key),
          )
        )
          throw new Error(file + ": unknown declaration field");
        if (source.config !== undefined && !Array.isArray(source.config))
          throw new Error(file + ": expected a config list");
        const scenarios = Object.fromEntries(
          Object.entries(record(source.scenarios)).map(([key, value]) => {
            if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key))
              throw new Error("Invalid scenario key: " + key);
            const plan = record(value);
            return [key, { ...plan, file, title: text(plan.title), targets: record(plan.targets) }];
          }),
        );
        const runs = Object.fromEntries(
          Object.entries(record(source.runs)).map(([key, value]) => {
            const ids = strings(value);
            const scenario = scenarios[key];
            const scheduled =
              scenario &&
              Object.values(scenario.targets).some(
                (target) => record(target).status === "scheduled",
              );
            if (!scenario || (!ids.length && scheduled) || new Set(ids).size !== ids.length)
              throw new Error(file + ": invalid scenario assignment " + key);
            for (const id of ids) {
              const group = groups[id];
              if (!group) throw new Error("Unknown e2e group: " + id);
              const target = record(scenario.targets[group.target]);
              if (target.status !== "scheduled" || (target.runtime ?? "managed") !== group.mode)
                throw new Error(file + ": group runtime does not match " + key);
            }
            return [key, ids];
          }),
        );
        for (const key of Object.keys(scenarios))
          if (!runs[key]) throw new Error(file + ": scenario has no CI job: " + key);
        const config =
          source.config === undefined
            ? []
            : (Array.isArray(source.config) ? source.config : []).map((value) => {
                const item = record(value);
                const job = text(item.job);
                if (!heavyJobs.includes(job) && job !== "fast")
                  throw new Error("Unknown config job: " + job);
                const config = text(item.config);
                if (!/^[a-z0-9-]+\.config\.ts$/.test(config))
                  throw new Error("Invalid test config: " + config);
                return {
                  job,
                  config,
                  titles: item.titles === undefined ? [] : strings(item.titles),
                };
              });
        const inherited = source.inherited === undefined ? [] : strings(source.inherited);
        if (!Object.keys(scenarios).length && !config.length && !inherited.length)
          throw new Error(file + ": test has no declared owner or CI job");
        const inputs = source.inputs === undefined ? [] : strings(source.inputs);
        if (inputs.some((path) => !isRelativeInput(path)))
          throw new Error(file + ": input escapes the repository");
        for (const input of inputs) {
          matchesInput ??= frozenInputMatcher(root);
          if (!matchesInput(input))
            throw new Error(file + ": input matches no frozen source or carried target: " + input);
        }
        const fixture =
          source.fixture === undefined
            ? undefined
            : choice(source.fixture, ["google-routes", "pool-setup"] as const);
        return [file, { scenarios, runs, config, inherited, inputs, fixture }];
      }),
  );
  for (const [file, entry] of Object.entries(files))
    for (const [key, scenario] of Object.entries(entry.scenarios)) {
      for (const target of targets) {
        const applicability = record(scenario.targets[target]);
        if (applicability.status !== "scheduled") continue;
        const runtime = applicability.runtime ?? "managed";
        if (
          entry.runs[key]!.some(
            (id) => groups[id]!.target === target && groups[id]!.mode === runtime,
          )
        )
          continue;
        const manual = manualTargets[key];
        if (
          !manual ||
          manual.file !== file ||
          manual.target !== target ||
          manual.runtime !== runtime
        )
          throw new Error(file + ": scheduled target has no CI job: " + key + " / " + target);
        if (
          target !== "cloud" ||
          !entry.runs[key]!.some((id) => groups[id]!.target === "self-host")
        )
          throw new Error(key + ": inherited manual coverage requires a self-host CI counterpart");
      }
    }
  for (const [key, manual] of Object.entries(manualTargets)) {
    const entry = files[manual.file];
    const applicability = entry?.scenarios[key]?.targets[manual.target];
    if (
      !applicability ||
      record(applicability).status !== "scheduled" ||
      record(applicability).runtime !== manual.runtime
    )
      throw new Error("Stale inherited manual target: " + key);
  }
  return { groups, files, manualTargets };
}

export function patternForGroup(group: string, file?: string, root = repository) {
  const declarations = readDeclarations(root);
  if (!declarations.groups[group]) throw new Error("Unknown e2e group: " + group);
  const titles = Object.entries(declarations.files).flatMap(([name, entry]) =>
    file !== undefined && file !== name
      ? []
      : Object.entries(entry.runs)
          .filter(([, runs]) => runs.includes(group))
          .map(([key]) => entry.scenarios[key]!.title),
  );
  if (!titles.length) throw new Error("No scenarios assigned to e2e group: " + group);
  return "^(?:" + [...new Set(titles)].map(escape).join("|") + ")$";
}

export function patternForConfig(file: string, root = repository) {
  const entry = readDeclarations(root).files[file];
  const titles = entry?.config.flatMap((config) => config.titles) ?? [];
  if (!titles.length) throw new Error("Config has no declared scenario names: " + file);
  return "^(?:" + [...new Set(titles)].map(escape).join("|") + ")$";
}

export function declaredMatrices(selected: readonly string[] | null = null, root = repository) {
  const { groups, files } = readDeclarations(root);
  return Object.fromEntries(
    targets.map((target) => [
      "declared-" + target,
      {
        include: Object.entries(files)
          .filter(([file]) => selected === null || selected.includes(file))
          .flatMap(([file, entry]) =>
            [...new Set(Object.values(entry.runs).flat())]
              .filter((id) => groups[id]!.matrix && groups[id]!.target === target)
              .map((group) => ({ file, group, key: group.replaceAll(":", "-") })),
          ),
      },
    ]),
  );
}

export function matchingDeclarations(path: string, declarations = readDeclarations()) {
  const match = /^(?:\.upstream\/e2e\/tests\/|e2e\/plans\/)([a-z0-9-]+\.spec\.ts)(?:\.json)?$/.exec(
    path,
  );
  const { files, groups } = declarations;
  return Object.entries(files)
    .filter(
      ([file, entry]) =>
        match?.[1] === file || entry.inputs.some((input) => matchesGlob(path, input)),
    )
    .map(([file, entry]) => ({
      file,
      jobs: [
        ...new Set([
          ...Object.values(entry.runs)
            .flat()
            .map((id) => groups[id]!.job),
          ...entry.config.map((item) => item.job),
        ]),
      ],
    }));
}

export function prepareTestPlans(root: string, upstream: string) {
  const { files } = readDeclarations(root);
  const plans: Record<string, unknown> = {};
  for (const entry of Object.values(files))
    for (const [key, plan] of Object.entries(entry.scenarios)) {
      if (Object.hasOwn(plans, key)) throw new Error("Duplicate declared scenario key: " + key);
      plans[key] = plan;
    }
  const path = join(upstream, "e2e/basalt-plans.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(plans, null, 2) + "\n");
  // Human in the loop no longer has Rules. Its obsolete draft journey is added by a later carry.
  rmSync(join(upstream, "e2e/tests/tool-policy-draft.spec.ts"), { force: true });
  return Object.keys(plans).length;
}
