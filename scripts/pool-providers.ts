import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `site` is the provider's public web address, used only to show its logo. */
export type PoolProvider = { id: string; name: string; site?: string };

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]*$/;
const SITE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RELEASES_URL = new URL("../containers/pool/releases.json", import.meta.url);
const PROVIDERS_URL = new URL("../src/pool/providers.json", import.meta.url);
const OAUTH_SOURCE_PATH = "internal/cluster/management/oauth_v8.go";

function isIdentifierCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_]/.test(character);
}

function isWordAt(source: string, index: number, word: string): boolean {
  return (
    source.startsWith(word, index) &&
    !isIdentifierCharacter(source[index - 1]) &&
    !isIdentifierCharacter(source[index + word.length])
  );
}

function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (quote !== "`" && source[index] === "\\") {
      index += 1;
      continue;
    }
    if (source[index] === quote) return index;
  }
  throw new Error("Unterminated string in pinned OAuth source");
}

function skipLineComment(source: string, start: number): number {
  const newline = source.indexOf("\n", start + 2);
  return newline === -1 ? source.length : newline;
}

function skipBlockComment(source: string, start: number): number {
  const end = source.indexOf("*/", start + 2);
  if (end === -1) throw new Error("Unterminated comment in pinned OAuth source");
  return end + 1;
}

function findMatchingBrace(source: string, open: number): number {
  if (source[open] !== "{") throw new Error("Expected an opening brace in pinned OAuth source");
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index);
    } else if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
    } else if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Unterminated block in pinned OAuth source");
}

function findDirectCaseExpressions(switchBody: string): string[] {
  const expressions: string[] = [];
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;

  for (let index = 0; index < switchBody.length; index += 1) {
    const character = switchBody[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(switchBody, index);
      continue;
    }
    if (character === "/" && switchBody[index + 1] === "/") {
      index = skipLineComment(switchBody, index);
      continue;
    }
    if (character === "/" && switchBody[index + 1] === "*") {
      index = skipBlockComment(switchBody, index);
      continue;
    }

    if (braces === 0 && parentheses === 0 && brackets === 0 && isWordAt(switchBody, index, "case")) {
      const expressionStart = index + "case".length;
      const colon = findCaseColon(switchBody, expressionStart);
      expressions.push(switchBody.slice(expressionStart, colon).trim());
      index = colon;
      continue;
    }

    if (character === "{") braces += 1;
    else if (character === "}") braces -= 1;
    else if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
  }
  return expressions;
}

function findCaseColon(source: string, start: number): number {
  let braces = 0;
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuoted(source, index);
    } else if (character === "/" && source[index + 1] === "/") {
      index = skipLineComment(source, index);
    } else if (character === "/" && source[index + 1] === "*") {
      index = skipBlockComment(source, index);
    } else if (character === "{") {
      braces += 1;
    } else if (character === "}") {
      braces -= 1;
    } else if (character === "(") {
      parentheses += 1;
    } else if (character === ")") {
      parentheses -= 1;
    } else if (character === "[") {
      brackets += 1;
    } else if (character === "]") {
      brackets -= 1;
    } else if (character === ":" && braces === 0 && parentheses === 0 && brackets === 0) {
      return index;
    }
  }
  throw new Error("Unterminated case in pinned OAuth source");
}

function parseStringCaseLabels(expression: string): string[] {
  const labels: string[] = [];
  let index = 0;
  while (index < expression.length) {
    while (/\s/.test(expression[index] ?? "")) index += 1;
    if (index === expression.length) break;
    if (expression[index] !== '"') {
      throw new Error(`Unsupported OAuth provider case expression: ${expression}`);
    }
    const end = expression.indexOf('"', index + 1);
    if (end === -1) throw new Error(`Unterminated OAuth provider case expression: ${expression}`);
    const label = expression.slice(index + 1, end);
    if (label !== "" && !PROVIDER_ID.test(label)) {
      throw new Error(`Invalid OAuth provider id in pinned source: ${label}`);
    }
    labels.push(label);
    index = end + 1;
    while (/\s/.test(expression[index] ?? "")) index += 1;
    if (index === expression.length) break;
    if (expression[index] !== ",") {
      throw new Error(`Unsupported OAuth provider case expression: ${expression}`);
    }
    index += 1;
  }
  if (labels.length === 0) throw new Error("Empty OAuth provider case in pinned source");
  return labels;
}

export function extractOAuthProviderIds(goSource: string): string[] {
  const functionPattern = /\bfunc\s+\([^)]*\)\s*StartOAuthV8\s*\([^)]*\)\s*\{/g;
  const functionMatch = functionPattern.exec(goSource);
  if (!functionMatch) throw new Error("Could not find StartOAuthV8 in pinned OAuth source");
  const functionOpen = functionMatch.index + functionMatch[0].lastIndexOf("{");
  const functionClose = findMatchingBrace(goSource, functionOpen);
  const functionBody = goSource.slice(functionOpen + 1, functionClose);
  const switchPattern = /\bswitch\s+strings\s*\.\s*ToLower\s*\(\s*strings\s*\.\s*TrimSpace\s*\(\s*c\s*\.\s*Query\s*\(\s*"provider"\s*\)\s*\)\s*\)\s*\{/g;
  const switchMatch = switchPattern.exec(functionBody);
  if (!switchMatch) throw new Error("Could not find the provider signin switch in StartOAuthV8");
  const switchOpen = switchMatch.index + switchMatch[0].lastIndexOf("{");
  const switchClose = findMatchingBrace(functionBody, switchOpen);
  const switchBody = functionBody.slice(switchOpen + 1, switchClose);
  const ids: string[] = [];

  for (const expression of findDirectCaseExpressions(switchBody)) {
    const labels = parseStringCaseLabels(expression);
    // Shared handlers can select different login domains and credential types, as Kimi does.
    for (const id of labels) {
      if (!id) continue;
      if (ids.includes(id)) throw new Error(`Duplicate OAuth provider id: ${id}`);
      ids.push(id);
    }
  }
  if (ids.length === 0) throw new Error("No OAuth provider ids found in StartOAuthV8");
  return ids;
}

function titleCaseProviderId(id: string): string {
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function buildProviderTable(
  ids: readonly string[],
  existing: readonly PoolProvider[] = [],
): PoolProvider[] {
  const known = new Map(existing.map((provider) => [provider.id, provider]));
  return ids.map((id) => {
    const site = known.get(id)?.site;
    return { id, name: known.get(id)?.name ?? titleCaseProviderId(id), ...(site ? { site } : {}) };
  });
}

function parseProviderTable(text: string): PoolProvider[] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value)) throw new Error("Provider table must be a JSON array");
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (
      row === null ||
      typeof row !== "object" ||
      !("id" in row) ||
      typeof row.id !== "string" ||
      !PROVIDER_ID.test(row.id) ||
      !("name" in row) ||
      typeof row.name !== "string" ||
      row.name.trim() === ""
    ) {
      throw new Error("Provider table rows must have a provider id and display name");
    }
    if (ids.has(row.id)) throw new Error(`Duplicate provider id in provider table: ${row.id}`);
    ids.add(row.id);
    const site = "site" in row ? row.site : undefined;
    if (site !== undefined && (typeof site !== "string" || !SITE.test(site)))
      throw new Error(`Provider site must be a bare domain: ${row.id}`);
    return { id: row.id, name: row.name, ...(site ? { site } : {}) };
  });
}

export function renderProviderTable(providers: readonly PoolProvider[]): string {
  return `${JSON.stringify(providers, null, 2)}\n`;
}

export function assertProviderIdsMatch(
  actual: readonly string[],
  expected: readonly string[],
  source: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Provider ids differ from ${source}: expected ${expected.join(", ")}; found ${actual.join(", ")}`,
    );
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === code
  );
}

async function readExistingProviders(): Promise<PoolProvider[]> {
  try {
    return parseProviderTable(await readFile(PROVIDERS_URL, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function fetchPinnedOAuthSource(): Promise<{ source: string; repository: string; tag: string; commit: string }> {
  const releaseText = await readFile(RELEASES_URL, "utf8");
  const release: unknown = JSON.parse(releaseText);
  if (
    release === null ||
    typeof release !== "object" ||
    !("artifacts" in release) ||
    release.artifacts === null ||
    typeof release.artifacts !== "object" ||
    !("home" in release.artifacts) ||
    release.artifacts.home === null ||
    typeof release.artifacts.home !== "object"
  ) {
    throw new Error("containers/pool/releases.json has no artifacts.home release");
  }
  const home = release.artifacts.home;
  if (
    !("repository" in home) ||
    typeof home.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(home.repository) ||
    !("tag" in home) ||
    typeof home.tag !== "string" ||
    !("commit" in home) ||
    typeof home.commit !== "string" ||
    !/^[a-f0-9]{40}$/i.test(home.commit)
  ) {
    throw new Error("containers/pool/releases.json has invalid artifacts.home source metadata");
  }
  const url = `https://raw.githubusercontent.com/${home.repository}/${home.commit}/${OAUTH_SOURCE_PATH}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Pinned OAuth source fetch failed with HTTP ${response.status}`);
  return { source: await response.text(), repository: home.repository, tag: home.tag, commit: home.commit };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.length === 1 && args[0] === "--check";
  if (args.length > 0 && !check) throw new Error("Usage: node scripts/pool-providers.ts [--check]");

  const pinned = await fetchPinnedOAuthSource();
  const ids = extractOAuthProviderIds(pinned.source);
  const existing = await readExistingProviders();
  const generated = buildProviderTable(ids, existing);
  const rendered = renderProviderTable(generated);

  if (check) {
    const existingIds = existing.map(({ id }) => id);
    assertProviderIdsMatch(existingIds, ids, `${pinned.repository}@${pinned.commit}`);
    const current = await readFile(PROVIDERS_URL, "utf8");
    if (current !== rendered) throw new Error("Provider names or formatting differ from generated table");
    console.log(`Provider ids match ${pinned.repository}@${pinned.commit} (${pinned.tag})`);
    return;
  }

  await writeFile(PROVIDERS_URL, rendered);
  console.log(`Wrote ${ids.length} provider ids from ${pinned.repository}@${pinned.commit} (${pinned.tag})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
