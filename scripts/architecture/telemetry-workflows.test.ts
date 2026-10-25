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
    "deploy.yml:deploy", "release-manual.yml:deploy", "release-rollback.yml:rollback",
  ]);
});
