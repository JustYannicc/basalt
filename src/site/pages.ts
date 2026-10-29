import { brand } from "../../brand.ts";
import { home, legalPages, type Block, type LegalPage } from "./content.ts";

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/** Escapes the text, then expands `**bold**` and `[label](href)`; no other markup gets through. */
export function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // Only web, mail and same-site links; anything else stays as written.
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:|\/)[^)\s]*)\)/g, '<a href="$2">$1</a>');
}

function block(item: Block): string {
  if ("h2" in item) return `<h2>${inline(item.h2)}</h2>`;
  if ("ul" in item) return `<ul>${item.ul.map((entry) => `<li>${inline(entry)}</li>`).join("")}</ul>`;
  if ("lines" in item) return `<p>${item.lines.map(inline).join("<br>")}</p>`;
  return `<p>${inline(item.p)}</p>`;
}

// The dashboard's own faces and quiet palette, so the site reads as the same product.
const style = `
@font-face{font-family:Geist;src:url(/brand/fonts/geist-sans.woff2) format("woff2");font-weight:100 900;font-display:swap}
@font-face{font-family:"Geist Mono";src:url(/brand/fonts/geist-mono.woff2) format("woff2");font-weight:100 900;font-display:swap}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;color:#0a0a0a;font:15px/1.65 Geist,system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.page{max-width:680px;min-height:100vh;min-height:100svh;margin:0 auto;padding:40px 24px 32px;display:flex;flex-direction:column}
.mark{display:inline-flex;align-items:center;gap:10px;color:inherit;text-decoration:none;font:500 15px "Geist Mono",ui-monospace,monospace}
.mark img{width:28px;height:28px;border-radius:6px}
main{flex:1;padding:56px 0 48px}
a{color:inherit;text-underline-offset:3px}
.home main{display:flex;flex-direction:column;justify-content:center;padding:64px 0}
h1{margin:0 0 16px;font-size:clamp(30px,6vw,44px);line-height:1.12;letter-spacing:-.025em;font-weight:600}
.subheadline{margin:0 0 20px;color:#0a0a0a;font-size:20px;line-height:1.4;letter-spacing:-.01em}
.lede{margin:0 0 20px;max-width:56ch;color:#404040;font-size:17px;line-height:1.6}
.tagline{margin:0 0 32px;color:#737373;font:14px "Geist Mono",ui-monospace,monospace}
.action{align-self:flex-start;display:inline-flex;align-items:center;min-height:44px;padding:0 20px;border-radius:8px;background:#0a0a0a;color:#fff;font-weight:500;text-decoration:none}
.action:hover{background:#262626}
.note{margin:40px 0 0;max-width:56ch;color:#737373;font-size:13px}
.legal h1{font-size:30px;margin-bottom:8px}
.summary{margin:0;color:#737373}
.updated{margin:4px 0 32px;color:#737373;font-size:13px}
h2{margin:36px 0 8px;font-size:17px;font-weight:600;letter-spacing:-.01em}
p,ul{margin:0 0 14px;color:#262626}
ul{padding-left:20px}
li{margin:0 0 8px}
footer{display:flex;flex-wrap:wrap;gap:6px 14px;padding-top:20px;border-top:1px solid #e5e5e5;color:#737373;font-size:13px}
footer a{text-decoration:none}
footer a:hover{color:#0a0a0a;text-decoration:underline}
:focus-visible{outline:2px solid #0a0a0a;outline-offset:2px}
`;

function footer(): string {
  const links: ReadonlyArray<readonly [string, string]> = [
    ...legalPages.map((page) => [page.label, page.path] as const),
    ["Contact", `mailto:${brand.site.email}`],
    ...(brand.links.source === null ? [] : [["GitHub", brand.links.source] as const]),
  ];
  return `<footer><span>© 2026 ${escapeHtml(brand.name)}</span>${links
    .map(([label, href]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
    .join("")}</footer>`;
}

function document(title: string, description: string, kind: "home" | "legal", content: string): string {
  const name = escapeHtml(brand.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><link rel="icon" href="${escapeHtml(brand.logo)}"><style>${style}</style></head><body><div class="page ${kind}"><header><a class="mark" href="/"><img src="${escapeHtml(brand.logo)}" alt="" width="28" height="28"><span>${name.toLowerCase()}</span></a></header><main>${content}</main>${footer()}</div></body></html>`;
}

function homePage(): string {
  return document(
    brand.name,
    home.note,
    "home",
    `<h1>${inline(home.headline)}</h1><p class="subheadline">${inline(home.subheadline)}</p><p class="lede">${inline(home.body)}</p><p class="tagline">${inline(home.tagline)}</p><a class="action" href="${escapeHtml(home.action.href)}">${escapeHtml(home.action.label)}</a><p class="note">${inline(home.note)}</p>`,
  );
}

function legalPage(page: LegalPage): string {
  return document(
    `${page.title} · ${brand.name}`,
    page.summary,
    "legal",
    `<h1>${inline(page.title)}</h1><p class="summary">${inline(page.summary)}</p><p class="updated">Last updated ${brand.site.updated}</p>${page.blocks.map(block).join("")}`,
  );
}

const notFound = () =>
  document(
    `Page not found · ${brand.name}`,
    "Page not found",
    "legal",
    `<h1>Page not found</h1><p><a href="/">Go to the ${escapeHtml(brand.name)} home page</a></p>`,
  );

// Every page is built from constants, so each is rendered once when the Worker starts.
const pages = new Map<string, string>([
  ["/", homePage()],
  ...legalPages.map((page) => [page.path, legalPage(page)] as const),
]);
const missing = notFound();

/** The site's pages by path; a trailing slash names the same page. */
export function sitePage(pathname: string): { readonly status: 200 | 404; readonly html: string } {
  const html = pages.get(pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname);
  return html === undefined ? { status: 404, html: missing } : { status: 200, html };
}
