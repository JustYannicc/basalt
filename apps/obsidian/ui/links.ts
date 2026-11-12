/** In-page targets for wikilinks and embeds; the note components only follow these and http(s). */
export const noteHref = (path: string) => `#note=${encodeURIComponent(path)}`;
export const fileHref = (path: string) => `#file=${encodeURIComponent(path)}`;

export function linkTarget(
  href: string | undefined,
): { readonly kind: "note" | "file"; readonly path: string } | null {
  const match = href?.match(/^#(note|file)=(.+)$/);
  if (!match) return null;
  try {
    return { kind: match[1] as "note" | "file", path: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
};
export const imageType = (path: string) =>
  imageTypes[path.split(".").pop()?.toLowerCase() ?? ""] ?? null;
