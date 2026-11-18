/**
 * Which Worker version annotations may be copied from a Cloudflare read into a write.
 * Cloudflare stamps provider-managed keys on every version and returns them from settings and
 * version reads; a request must never carry them, and they never take part in a request-vs-read-back
 * comparison. Caller-owned keys are Cloudflare's documented writable annotations. Any other key is
 * unknown: callers refuse it rather than guess which side owns it.
 */
export const providerManagedAnnotations: ReadonlySet<string> = new Set(["workers/triggered_by"]);
export const callerOwnedAnnotations: ReadonlySet<string> = new Set([
  "workers/alias",
  "workers/commit_sha",
  "workers/message",
  "workers/pull_request_number",
  "workers/pull_request_title",
  "workers/pull_request_url",
  "workers/repository_url",
  "workers/tag",
]);

/** The SDK decodes `workers/triggered_by` as `workersTriggeredBy`; wire names pass through unchanged. */
export const annotationWireName = (key: string) =>
  key.replace(/[A-Z]/gu, (char) => `_${char.toLowerCase()}`).replace(/^workers_/u, "workers/");

/**
 * Caller-owned entries only, in the caller's key style. Provider-managed keys and null values are
 * dropped; `refuse` receives the wire name of any key that is neither and must throw.
 */
export function callerAnnotations<T extends object>(
  annotations: T | null | undefined,
  refuse: (wireName: string) => never,
): Partial<T> {
  if (!annotations) return {};
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(annotations)) {
    const wire = annotationWireName(key);
    if (providerManagedAnnotations.has(wire)) continue;
    if (!callerOwnedAnnotations.has(wire)) refuse(wire);
    if (value != null) kept[key] = value;
  }
  return kept as Partial<T>;
}
