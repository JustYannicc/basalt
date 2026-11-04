// A lab's identity colour. State (out, flagged, failing) always uses the destructive and warning
// tokens with an icon and words, so a lab hue never has to say anything on its own.
const colors: Record<string, string> = {
  codex: "var(--lab-codex)",
  claude: "var(--lab-claude)",
  kimi: "var(--lab-kimi)",
  "kimi-ai": "var(--lab-kimi)",
};

export const labColor = (provider: string | null) =>
  (provider && colors[provider]) || "color-mix(in srgb, var(--foreground) 55%, transparent)";

/** Providers declare no icon yet, so a lab shows as its colour and initial. */
export function LabMark({
  provider,
  name,
  small = false,
}: {
  provider: string;
  name: string;
  small?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-semibold text-white ${small ? "size-[18px] rounded-[5px] text-[10px]" : "size-6 rounded-md text-xs"}`}
      style={{ background: labColor(provider) }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
