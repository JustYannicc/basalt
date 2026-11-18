import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { isRehearsalStage } from "./release-stage.ts";

/**
 * Rehearsal-only: records the key names and JSON types of the Cloudflare responses a release
 * depends on, so a real stage answers what offline stand-ins cannot. Never values or ids, except
 * short enum-like fields (`status`, `state`, `kind`) and `workers/*` annotation keys. On any other
 * stage, or without a capture directory, it installs nothing.
 */
const watched: readonly [label: string, pattern: RegExp][] = [
  ["container-application", /\/containers\/applications(?:\/[^/]+)?$/u],
  ["container-rollout", /\/containers\/applications\/[^/]+\/rollouts(?:\/[^/]+)?$/u],
  ["container-instances", /\/containers\/applications\/[^/]+\/instances/u],
  ["worker-version", /\/workers\/(?:scripts|workers)\/[^/]+\/versions(?:\/[^/]+)?$/u],
  ["worker-settings", /\/workers\/scripts\/[^/]+\/(?:script-)?settings$/u],
  ["worker-deployments", /\/workers\/scripts\/[^/]+\/deployments$/u],
];
const enumKeys = new Set(["status", "state", "kind", "strategy", "type", "health"]);

export function shapeOf(value: unknown, key = "", depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value))
    return value.length ? [shapeOf(value[0], key, depth + 1)] : "empty-array";
  if (value === null) return "null";
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, item]) => [
        name,
        name.startsWith("workers/") && typeof item === "string"
          ? `string:${item.slice(0, 40)}`
          : shapeOf(item, name, depth + 1),
      ]),
    );
  }
  if (
    typeof value === "string" &&
    enumKeys.has(key) &&
    value.length <= 40 &&
    !/[0-9a-f]{16,}/u.test(value)
  )
    return `string:${value}`;
  return typeof value;
}

export function installShapeCapture(env: NodeJS.ProcessEnv = process.env): boolean {
  const directory = env.BASALT_REHEARSAL_CAPTURE_DIR;
  if (!directory || !isRehearsalStage(env.ALCHEMY_STAGE)) return false;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `capture-${process.pid}.jsonl`);
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await original(input, init);
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const match = watched.find(([, pattern]) => pattern.test(url.pathname));
      if (!match && !response.ok) {
        // A refusal from anything else, such as the stage's own runtime endpoints: the message says why.
        const text = (await response.clone().text())
          .replace(/[0-9a-f]{16,}/giu, "[hex]")
          .slice(0, 300);
        appendFileSync(
          file,
          `${JSON.stringify({ at: new Date().toISOString(), label: "refusal", host: url.hostname.split(".").slice(-2).join("."), status: response.status, message: text })}\n`,
        );
      }
      if (match) {
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        const text = await response.clone().text();
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = `non-json:${text.length}`;
        }
        appendFileSync(
          file,
          `${JSON.stringify({
            at: new Date().toISOString(),
            label: match[0],
            method,
            query: [...url.searchParams.keys()].sort(),
            status: response.status,
            shape: shapeOf(body),
          })}\n`,
        );
      }
    } catch {
      // Capture never changes what the release sees.
    }
    return response;
  }) as typeof fetch;
  return true;
}

installShapeCapture();
