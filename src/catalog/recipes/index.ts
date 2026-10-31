import { brand } from "../../../brand.ts";
import type { Addition } from "../feed.ts";
import operator from "./operator.json" with { type: "json" };
import poolOwner from "./pool-owner.json" with { type: "json" };
import personal from "./personal.json" with { type: "json" };

const sources = [
  {
    id: "checks-operator",
    name: "Production checks",
    description:
      "Editable production check workflows. Configure sources and your connected nudge channel; schedules start paused.",
    source: operator,
  },
  {
    id: "checks-pool-owner",
    name: "My pool checks",
    description:
      "Private quota checks for pools you own, with a workflow question when capacity needs a decision.",
    source: poolOwner,
  },
  {
    id: "checks-personal",
    name: "My connection checks",
    description:
      "Private checks that ask you to reconnect only after a current native credential refusal.",
    source: personal,
  },
];
/** Only the installation origin and product name vary. Private copies and destinations stay private. */
export function recipeAdditions(origin: string): Addition[] {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol))
    throw new Error("Invalid installation origin.");
  return sources.map(({ source, ...entry }) => ({
    entry: {
      ...entry,
      package: source.package,
      source: `apps/${entry.id}.json`,
      icons: [],
      auth: [
        { method: "apiKey", kind: "secrets", label: `${brand.name} API key` },
        { method: "oauth", kind: "oauth2", label: "Sign in" },
      ],
    },
    source: {
      ...source,
      files: source.files.map((file) =>
        file.path !== "common/installation.ts"
          ? file
          : {
              ...file,
              content: file.content
                .replace(
                  'export const origin = "https://app.signalbox.run";',
                  `export const origin = ${JSON.stringify(origin)};`,
                )
                .replace('name: "Signalbox"', `name: ${JSON.stringify(brand.name)}`)
                .replace(
                  'label: "Signalbox API key"',
                  `label: ${JSON.stringify(`${brand.name} API key`)}`,
                ),
            },
      ),
    },
  }));
}
