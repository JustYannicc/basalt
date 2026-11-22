import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parse } from "yaml";

test("every release job with a capture key also receives its configured region", () => {
  const directory = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));
  const releases: string[] = [];
  for (const name of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = parse(readFileSync(join(directory, name), "utf8"));
    for (const [job, configuration] of Object.entries(workflow.jobs ?? {})) {
      const { env, steps } = configuration as {
        env?: Record<string, string>;
        steps?: Array<{ env?: Record<string, string> }>;
      };
      // A job may scope its secrets to the steps that need them.
      const scopes = [env, ...(steps ?? []).map((step) => step.env)].filter(
        (scope) => scope?.POSTHOG_PROJECT_KEY,
      );
      if (!scopes.length) continue;
      releases.push(`${name}:${job}`);
      for (const scope of scopes)
        expect(scope!.POSTHOG_HOST, `${name}:${job}`).toBe("${{ secrets.POSTHOG_HOST }}");
    }
  }
  expect(releases.sort()).toEqual(["production.yml:production", "release.yml:release"]);
});
