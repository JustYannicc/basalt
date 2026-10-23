import { readFileSync } from "node:fs";
import { join } from "node:path";
import { filesBelow } from "./source.ts";

const replacements: [RegExp, string][] = [
  [/Executor/i, "tools gateway"],
  [/CLIProxyAPI(?:Home)?|CPA/i, "model gateway"],
  [/boxd/i, "machine"],
  [/Artifacts/i, "fork"],
  [/Kernel/i, "browser"],
  [/1Password/i, "vault"],
  [/WorkOS|AuthKit/i, "identity provider"],
  [/R2/i, "record storage"],
  [/D1|Planetscale|Neon/i, "database adapter"],
  [/Sentry|PostHog|Axiom/i, "observability adapter"],
  [/Cloudflare|Durable Objects?|Workers/i, "runtime adapter"],
  [/Google|GitHub|GitLab|Atlassian|Confluence|Slack|ElevenLabs|AWS|Amazon/i, "outside service"],
  [/Anthropic|OpenAI|ChatGPT|Codex|Claude|Grok/i, "model provider"],
];
const vendors = new RegExp(`\\b(?:${replacements.map(([pattern]) => pattern.source).join("|")})\\b`, "i");
export function languageErrors(root: string): string[] {
  const errors: string[] = [];
  for (const file of filesBelow(join(root, "architecture"))) {
    if (!/\.(c4|likec4|md|json)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    // Only adapter technology may name a replaceable product. The API check also
    // rejects product technology attached to any other kind of element.
    const withoutTechnology = file.endsWith(".md") ? text : text.replace(/\btechnology\s+(['"])(?:\\.|(?!\1)[\s\S])*?\1/g, "");
    withoutTechnology.split("\n").forEach((line, index) => {
      const match = line.match(vendors);
      if (match) {
        const replacement = replacements.find(([pattern]) => pattern.test(match[0]))![1];
        errors.push(`${file.slice(root.length + 1)}:${index + 1}: use '${replacement}' from CONTEXT.md instead of ${match[0]}`);
      }
    });
  }
  return errors;
}
export const hasVendor = (text: string) => vendors.test(text);

export function glossaryValues(glossary: string, heading: string): Set<string> {
  const section = glossary.split(`## ${heading}\n`)[1]?.split(/\n## /)[0];
  if (!section) throw new Error(`Missing glossary section: ${heading}`);
  return new Set([...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(match => match[1]!));
}
