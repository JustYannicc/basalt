/**
 * Worker and dashboard diagnostics share credential redaction. The feedback parity test keeps
 * this policy aligned with the page before either sink retains exception text.
 */
const secrets: ReadonlyArray<readonly [RegExp, (match: string, name?: string) => string]> = [
  [
    /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key)\b["']?\s*[:=]\s*[^\n]*/gi,
    (_, name) => `${name}: [redacted]`,
  ],
  [
    /\b(password|passwd|secret|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|token)\b["']?\s*[:=]\s*["']?[^\s"'&,;}]+/gi,
    (_, name) => `${name}=[redacted]`,
  ],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, (_, name) => `${name} [redacted]`],
  [/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, () => "[jwt]"],
  [
    /\b(?:sk|pk|rk|sb|ghp|gho|ghu|ghs|ghr|glpat|github_pat|xox[abprs])[-_][\w-]{8,}/gi,
    () => "[key]",
  ],
  [/[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[a-z]{2,}/gi, () => "[email]"],
  [/[\w.+-]+%40[\w.-]+\.[a-z]{2,}/gi, () => "[email]"],
  [/\b[0-9a-f]{32,}\b/gi, () => "[hex]"],
  [/[\w+-]{32,}={0,2}/g, (match) => (/\d/.test(match) && /[a-z]/i.test(match) ? "[token]" : match)],
  [
    /[A-Za-z\d+/]{40,}={0,2}/g,
    (match) => (/\d/.test(match) && /[a-z]/.test(match) && /[A-Z]/.test(match) ? "[token]" : match),
  ],
];
const queries = /((?:[a-z][a-z\d+.-]*:)?\/\/[^\s?#"'<>]+|\/[^\s?#"'<>]*)[?#][^\s"'<>]*/gi;

export function redactLogText(text: string): string {
  return secrets.reduce(
    (result, [pattern, replace]) => result.replace(pattern, replace),
    text.replace(queries, "$1"),
  );
}
