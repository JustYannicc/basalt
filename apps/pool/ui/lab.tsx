import { useState } from "react";
import type { Provider } from "../contract.ts";
import { iconSources, type Icons } from "./lab-icon.ts";

// A lab's series colour in charts and bars. State (out, flagged, failing) always uses the
// destructive and warning tokens with an icon and words, so a lab hue never has to say anything on
// its own. The mark itself is the provider app's icon, never this colour.
const colors: Record<string, string> = {
  codex: "var(--lab-codex)",
  claude: "var(--lab-claude)",
  kimi: "var(--lab-kimi)",
  "kimi-ai": "var(--lab-kimi)",
};

export const labColor = (provider: string | null) =>
  (provider && colors[provider]) || "color-mix(in srgb, var(--foreground) 55%, transparent)";

/** The pool's provider entry for a lab id, carrying the icons its provider app declares. */
export const labProvider =
  (providers: readonly Provider[] | undefined) =>
  (id: string): Provider | undefined =>
    providers?.find((provider) => provider.id === id);

/**
 * The provider app's own icon. Until the pool view names the provider, or when its app declares no
 * loadable icon, a neutral tile holds the place: never an initial or a made-up brand.
 */
export function LabMark({
  provider,
  small = false,
}: {
  provider: { readonly icons?: Icons } | undefined;
  small?: boolean;
}) {
  const sources = iconSources(provider?.icons);
  const [broken, setBroken] = useState<string>();
  const size = small ? "size-[18px] rounded-[5px]" : "size-6 rounded-md";
  if (sources === null || broken === `${sources.light} ${sources.dark}`)
    return (
      <span
        aria-hidden="true"
        data-lab-mark="unavailable"
        // A borderless fill: an outlined square beside a label reads as a checkbox.
        className={`shrink-0 bg-foreground/10 ${size}`}
      />
    );
  return (
    <picture
      aria-hidden="true"
      data-lab-mark="icon"
      className={`block shrink-0 overflow-hidden ${size}`}
    >
      {sources.dark !== sources.light && (
        <source media="(prefers-color-scheme: dark)" srcSet={sources.dark} />
      )}
      <img
        src={sources.light}
        alt=""
        draggable={false}
        className="block size-full object-contain"
        onError={() => setBroken(`${sources.light} ${sources.dark}`)}
      />
    </picture>
  );
}
