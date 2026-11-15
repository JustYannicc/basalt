import { useState } from "react";
import { iconSources } from "./lab-icon.ts";
import { labLogos } from "./lab-logos.ts";
import type { LabIdentity } from "./lab-name.ts";

// A lab's series colour in charts and bars. State (out, flagged, failing) always uses the
// destructive and warning tokens with an icon and words, so a lab hue never has to say anything on
// its own. Provider icons keep their own colours; a missing icon uses the label badge.
const colors: Record<string, string> = {
  codex: "var(--lab-codex)",
  claude: "var(--lab-claude)",
  kimi: "var(--lab-kimi)",
  "kimi-ai": "var(--lab-kimi)",
};

export const labColor = (provider: string | null) =>
  (provider && colors[provider]) || "color-mix(in srgb, var(--foreground) 55%, transparent)";

const sizes = {
  small: "size-[18px] rounded-[5px]",
  medium: "size-[22px] rounded-md",
  large: "size-[30px] rounded-md",
};

/**
 * A lab's logo tile, the same in every overview section: the provider app's own icon when the pool
 * view supplies one, else the product logo the overview mock uses, else the lab name's initial.
 * Until the pool view lists the lab, the tile stays blank, like its name.
 */
export function LabMark({
  provider,
  identity,
  size = "medium",
}: {
  provider: string;
  identity: LabIdentity | undefined;
  size?: keyof typeof sizes;
}) {
  const own = iconSources(identity?.icons);
  const ownKey = own && `${own.light} ${own.dark}`;
  const logo = labLogos[provider];
  const [broken, setBroken] = useState<readonly string[]>([]);
  const tile = `shrink-0 overflow-hidden ${sizes[size]}`;
  if (identity === undefined)
    return (
      <span aria-hidden="true" data-lab-mark="pending" className={`block bg-accent ${tile}`} />
    );
  if (own !== null && ownKey !== null && !broken.includes(ownKey))
    return (
      <picture aria-hidden="true" data-lab-mark="icon" className={`block ${tile}`}>
        {own.dark !== own.light && (
          <source media="(prefers-color-scheme: dark)" srcSet={own.dark} />
        )}
        <img
          src={own.light}
          alt=""
          draggable={false}
          className="block size-full object-contain"
          onError={() => setBroken((previous) => [...previous, ownKey])}
        />
      </picture>
    );
  if (logo !== undefined && !broken.includes(logo))
    return (
      <span
        aria-hidden="true"
        data-lab-mark="logo"
        // The mock's white tile in both schemes: these logos are drawn for a light ground.
        className={`grid place-items-center bg-white ring-1 ring-black/10 dark:ring-white/10 ${tile}`}
      >
        <img
          src={logo}
          alt=""
          draggable={false}
          className="block size-[78%] object-contain"
          onError={() => setBroken((previous) => [...previous, logo])}
        />
      </span>
    );
  return (
    <span
      aria-hidden="true"
      data-lab-mark="unavailable"
      // A borderless fill: an outlined square beside a label reads as a checkbox.
      className={`grid place-items-center font-semibold text-white ${tile}`}
      style={{ background: labColor(provider) }}
    >
      {identity.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
