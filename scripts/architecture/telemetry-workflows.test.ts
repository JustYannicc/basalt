import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("every release job with a capture key also receives its configured region", () => {
  const directory = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const releases: string[] = [];
  for (const name of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    const workflow = parse(readFileSync(join(directory, name), "utf8"));
    for (const [job, configuration] of Object.entries(workflow.jobs ?? {})) {
      const env = (configuration as { env?: Record<string, string> }).env;
      if (!env?.POSTHOG_PROJECT_KEY) continue;
      releases.push(`${name}:${job}`);
      expect(env.POSTHOG_HOST, `${name}:${job}`).toBe("${{ secrets.POSTHOG_HOST }}");
    }
  }
  expect(releases.sort()).toEqual([
    "deploy.yml:deploy", "release-main.yml:deploy", "release-manual.yml:deploy", "release-rollback.yml:rollback",
  ]);
});

test("every production release job receives every secret the automatic deploy uses", () => {
  // A manual or rollback release that misses one would deploy production without that connector or setting.
  const directory = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const secrets = (name: string, job: string) => {
    const workflow = parse(readFileSync(join(directory, name), "utf8"));
    const configuration = workflow.jobs[job] as { env?: Record<string, string>; steps?: Array<{ env?: Record<string, string> }> };
    const values = [...Object.values(configuration.env ?? {}), ...(configuration.steps ?? []).flatMap(step => Object.values(step.env ?? {}))];
    return new Set(values.flatMap(value => [...String(value).matchAll(/secrets\.([A-Z0-9_]+)/g)].map(match => match[1]!)));
  };
  const automatic = secrets("deploy.yml", "deploy");
  expect(automatic.size).toBeGreaterThan(20);
  for (const [name, job] of [["release-main.yml", "deploy"], ["release-manual.yml", "deploy"], ["release-rollback.yml", "rollback"]] as const) {
    const missing = [...automatic].filter(secret => !secrets(name, job).has(secret));
    expect(missing, `${name}:${job}`).toEqual([]);
  }
});
