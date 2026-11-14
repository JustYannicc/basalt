import { allowanceEntry, object, sourceMaxAge, type PlanAllowance } from "./data.ts";

export const vendorSources = {
  openai: [
    "https://raw.githubusercontent.com/openai/codex/main/codex-rs/tui/src/subscription.rs",
    "https://api.fxtwitter.com/thsottiaux/status/2119296267545419987",
  ],
  "claude-max": ["https://support.claude.com/en/articles/11049741-what-is-the-max-plan"],
  "claude-ultra": ["https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan"],
  "x-subscription": ["https://docs.x.ai/x-subscription/pricing.md"],
} as const;
export type VendorSourceId = keyof typeof vendorSources;
const words = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["twenty", 20],
  ["fifty", 50],
]);
const number = (value: string) => words.get(value.toLowerCase()) ?? Number(value);
const plain = (value: string) =>
  value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(?:#x27|#39|apos);/giu, "'")
    .replace(/&(?:nbsp|amp|quot);/gu, " ")
    .replace(/\s+/gu, " ");
const claudeUnit = { id: "claude-pro-equivalent", label: "Pro-eq" };
const codexUnit = { id: "chatgpt-plus-equivalent", label: "Plus-eq" };

/** Parsers read explicit vendor statements; renamed tiers are not inferred from price. */
export function vendorAllowances(
  id: VendorSourceId,
  bodies: readonly string[],
  now: number,
): PlanAllowance[] {
  if (id === "openai") {
    const payload: unknown = JSON.parse(bodies[1]!);
    if (
      !object(payload) ||
      !object(payload.tweet) ||
      typeof payload.tweet.text !== "string" ||
      !object(payload.tweet.author) ||
      payload.tweet.author.screen_name !== "thsottiaux"
    )
      throw new Error("Invalid vendor statement");
    const statement = payload.tweet.text;
    const published =
      typeof payload.tweet.created_at === "string" ? Date.parse(payload.tweet.created_at) : NaN;
    if (
      !Number.isFinite(published) ||
      published > now ||
      now - published >= sourceMaxAge ||
      !/all Pro plans have no 5-hour limits/iu.test(statement)
    )
      throw new Error("Outdated vendor statement");
    const variants: Record<string, string> = { Pro: "pro", ProLite: "prolite", ProMax: "promax" };
    const entries: PlanAllowance[] = [];
    for (const match of bodies[0]!.matchAll(
      /PlanType::(Pro|ProLite|ProMax),[^\n]*=>\s*"Pro (\d+)"/gu,
    )) {
      const multiple = new RegExp(`Pro ${match[2]}\\s*=\\s*(\\d+(?:\\.\\d+)?)X`, "iu").exec(
        statement,
      );
      if (!multiple) continue;
      const full = Number(multiple[1]);
      if (!Number.isFinite(full) || full <= 0) continue;
      for (const seconds of [604_800, 18_000])
        entries.push(
          allowanceEntry({
            vendor: "openai",
            plan: variants[match[1]!]!,
            windowSeconds: seconds,
            full: seconds === 18_000 ? null : full,
            unit: codexUnit,
            kind: "vendor",
            verification: "verified",
            checkedAt: published,
            fetchedAt: now,
            sources: [
              vendorSources.openai[0],
              "https://x.com/thsottiaux/status/2119296267545419987",
            ],
            detail:
              "Official client identity and dated vendor staff statement; absolute weekly size unpublished",
            ...(seconds === 18_000 ? { unlimited: true } : {}),
          }),
        );
    }
    if (entries.length !== Object.keys(variants).length * 2)
      throw new Error("Vendor plan mapping changed");
    return entries;
  }
  if (id === "claude-max" || id === "claude-ultra") {
    const body = plain(bodies[0]!);
    const pattern =
      id === "claude-max"
        ? /(?:Get|includes)\s+(\d+(?:\.\d+)?|[a-z]+)\s+times the Pro plan(?:'|’)?s usage every five hours and every week/iu
        : /(?:Get|includes)\s+(\d+(?:\.\d+)?|[a-z]+)\s+times the Pro plan(?:'|’)?s usage every week/iu;
    const match = pattern.exec(body);
    const full = match ? number(match[1]!) : NaN;
    if (!Number.isFinite(full) || full <= 0) throw new Error("Vendor allowance statement changed");
    return (id === "claude-max" ? [18_000, 604_800] : [604_800]).map((windowSeconds) =>
      allowanceEntry({
        vendor: "anthropic",
        plan: id === "claude-max" ? "max_5x" : "ultra",
        windowSeconds,
        full,
        unit: claudeUnit,
        kind: "vendor",
        verification: "verified",
        sources: [...vendorSources[id]],
        checkedAt: now,
        fetchedAt: now,
        detail:
          id === "claude-ultra"
            ? "Weekly; verified Ultra accounts have no five-hour cap"
            : "Session and weekly allowance stated by the vendor",
      }),
    );
  }
  const entries: PlanAllowance[] = [];
  for (const line of bodies[0]!.split("\n")) {
    const match =
      /^\|?\s*(Plus|Premium|Super|Ultra)\s*\|[^|]+\|[^|]+\|\s*(Base|\d+(?:\.\d+)?x)\s*\|?\s*$/iu.exec(
        line,
      );
    if (!match) continue;
    entries.push(
      allowanceEntry({
        vendor: "xai",
        plan: `x_subscription_${match[1]!.toLowerCase()}`,
        windowSeconds: 604_800,
        full: match[2]!.toLowerCase() === "base" ? 1 : Number(match[2]!.slice(0, -1)),
        unit: { id: "x-subscription-plus-equivalent", label: "X Plus account" },
        kind: "vendor",
        verification: match[2]!.toLowerCase() === "base" ? "reference" : "verified",
        sources: [...vendorSources[id]],
        checkedAt: now,
        fetchedAt: now,
        detail: "Unified X Subscription only; legacy Grok plans are separate",
      }),
    );
  }
  if (!entries.length) throw new Error("Vendor pricing table changed");
  return entries;
}
