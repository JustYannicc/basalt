/**
 * Vault formats stored as Git text blobs, so their history diffs line by line. Everything else,
 * and any text file over `maximumTextBytes`, is stored as attachment bytes behind a pointer.
 * PDFs, raster images, audio, video and archives stay attachments.
 */
export const textExtensions: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "canvas",
  "base",
  "txt",
  "json",
  "csv",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "css",
  "html",
  "xml",
  "svg",
  "tex",
  "bib",
  "org",
  "ics",
  "js",
  "ts",
]);

/**
 * Each pushed version costs its full size against the vault's Git repository, and large
 * often-edited text barely benefits from diffs, so bigger text files go behind a pointer.
 */
export const maximumTextBytes = 1024 * 1024;

export function isTextPath(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1),
    dot = name.lastIndexOf(".");
  return dot > 0 && textExtensions.has(name.slice(dot + 1).toLowerCase());
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Only bytes that decode losslessly travel as text; a Latin-1 CSV must keep its exact bytes. */
export function isTextContent(bytes: Uint8Array) {
  if (bytes.includes(0)) return false;
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
}
