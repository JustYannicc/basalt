import { expect, test } from "vitest";
import ts from "typescript";
import { configurationIssues } from "./configuration.ts";

function issues(source: string): string[] {
  const parsed = ts.createSourceFile("brand.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return configurationIssues(parsed).map(issue => issue.message);
}

test("literal const objects support const assertions and nullable string annotations", () => {
  expect(issues(`
    export const brand = {
      name: "Signalbox",
      host: "app.example.test",
      links: { docs: null as string | null },
    } as const;
  `)).toEqual([]);
});

test("configuration rejects imports, executable declarations, calls, and computed properties", () => {
  expect(issues(`
    import { fetcher } from "./network.ts";
    export function load() { return fetcher("https://outside.example.test"); }
    export const config = { ["host"]: "app.example.test", result: fetch("https://outside.example.test") };
  `)).toEqual([
    "Configuration modules allow only literal const declarations",
    "Configuration modules allow only literal const declarations",
    "Configuration modules allow only literal const declarations",
  ]);
});

test("configuration rejects local aliases and spreads", () => {
  expect(issues(`
    const host = "app.example.test";
    export const config = { host, ...{ enabled: true } };
  `)).toEqual([
    "Configuration modules allow only literal const declarations",
  ]);
});
