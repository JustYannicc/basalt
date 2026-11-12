import { useEffect, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCallout from "@r4ai/remark-callout";
import remarkWikiLink from "@flowershow/remark-wiki-link";
import { noteHref, fileHref, linkTarget } from "./links.ts";

/**
 * Obsidian-flavoured Markdown, read-only: the dashboard's renderer (react-markdown + GFM, raw HTML
 * skipped) plus Flowershow's wikilink resolution and Obsidian callouts. Links between notes stay
 * inside this page; embedded images load from the vault.
 */
export function NoteMarkdown({
  content,
  files,
  onOpen,
  loadFile,
}: {
  readonly content: string;
  /** Every vault path, so `[[note]]` resolves by Obsidian's shortest-path rule. */
  readonly files: readonly string[];
  readonly onOpen: (path: string) => void;
  readonly loadFile: (path: string) => Promise<Blob | null>;
}) {
  const plugins = useMemo(
    () => [
      remarkGfm,
      remarkCallout,
      [
        remarkWikiLink,
        {
          format: "shortestPossible",
          files: [...files],
          urlResolver: ({ filePath, isEmbed }: { filePath: string; isEmbed: boolean }) =>
            isEmbed ? fileHref(filePath) : noteHref(filePath),
        },
      ] as const,
    ],
    [files],
  );
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, className }) => {
        const target = linkTarget(href);
        if (target?.kind === "note")
          return (
            <a
              href={href}
              className={className?.includes("new") ? "wikilink missing" : "wikilink"}
              onClick={(event) => {
                event.preventDefault();
                if (!className?.includes("new")) onOpen(target.path);
              }}
            >
              {children}
            </a>
          );
        const safe = href !== undefined && /^https?:\/\//i.test(href) ? href : undefined;
        return safe === undefined ? (
          <span>{children}</span>
        ) : (
          <a href={safe} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img: ({ src, alt, width }) => {
        const target = linkTarget(typeof src === "string" ? src : undefined);
        if (target?.kind === "file")
          return <VaultImage path={target.path} alt={alt ?? ""} width={width} load={loadFile} />;
        return <span className="embed-missing">{alt || "Image"}</span>;
      },
      iframe: ({ src }) => <EmbedChip src={src} />,
      video: ({ src }) => <EmbedChip src={src} />,
      audio: ({ src }) => <EmbedChip src={src} />,
    }),
    [onOpen, loadFile],
  );
  return (
    <div className="prose">
      <Markdown remarkPlugins={plugins as never} skipHtml components={components}>
        {content}
      </Markdown>
    </div>
  );
}

function EmbedChip({ src }: { readonly src?: string | undefined }): ReactNode {
  const target = linkTarget(src);
  const name = target?.path.split("/").pop() ?? "Attachment";
  return <span className="embed-chip">{name}</span>;
}

/** Images up to 8 MiB load from the vault; anything else shows its name. */
function VaultImage({
  path,
  alt,
  width,
  load,
}: {
  readonly path: string;
  readonly alt: string;
  readonly width?: string | number | undefined;
  readonly load: (path: string) => Promise<Blob | null>;
}) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    load(path)
      .then((blob) => {
        if (cancelled) return;
        made = blob === null ? null : URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => !cancelled && setUrl(null));
    return () => {
      cancelled = true;
      if (made !== null) URL.revokeObjectURL(made);
    };
  }, [path, load]);
  if (url === undefined) return <span className="embed-loading" aria-label={`Loading ${alt}`} />;
  if (url === null) return <span className="embed-chip">{path.split("/").pop()}</span>;
  return <img src={url} alt={alt} width={width} className="embed-image" />;
}
