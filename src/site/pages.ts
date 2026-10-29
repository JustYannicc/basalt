import { brand } from "../../brand.ts";
import { home, legalPages, type Block, type LegalPage } from "./content.ts";
import { height, introSeconds, width } from "./volcano.ts";

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

// A garamond on near-black, warm greys, hairline rules and the system sans for small print.
// Dark only: the site has no theme toggle.
const style = `
@font-face{font-family:"EB Garamond";src:url(/brand/serif/eb-garamond.woff2) format("woff2");font-weight:400 800;font-display:swap}
@font-face{font-family:"EB Garamond";src:url(/brand/serif/eb-garamond-italic.woff2) format("woff2");font-style:italic;font-weight:400 800;font-display:swap}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:dark}
body{margin:0;background:#09090b;color:#f8f8f4;font:18px/1.55 "EB Garamond",Georgia,serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:4px}
a:hover{color:#fff}
:focus-visible{outline:1px solid #ecebe6;outline-offset:3px}
.page{min-height:100vh;min-height:100svh;max-width:1180px;margin:0 auto;padding:0 32px;display:flex;flex-direction:column}
main{flex:1}
.mark{display:inline-flex;align-items:center;gap:8px;color:#f8f8f4;text-decoration:none;font:italic 22px/1 "EB Garamond",Georgia,serif}
.mark img{width:20px;height:20px;border-radius:5px;box-shadow:0 0 0 1px #303034}
.home main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:80px;align-items:center;padding:96px 0}
.art{position:relative;width:100%;max-width:560px;aspect-ratio:${width}/${height}}
.art img{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated}
.art .intro{animation:handover 0s linear ${introSeconds}s forwards}
@keyframes handover{to{visibility:hidden}}
h1{margin:0 0 28px;font-weight:400;font-size:clamp(40px,5vw,64px);line-height:1.04;letter-spacing:-.01em}
h1 em{display:block}
.lede{margin:0 0 18px;max-width:34em;color:#a3a29d}
.tagline{margin:28px 0 40px;font-style:italic;color:#f8f8f4}
.action{font-size:22px}
.note{margin:40px 0 0;max-width:40em;color:#6f6e6a;font:13px/1.6 system-ui,sans-serif}
header{padding:28px 0}
.legal main{width:100%;max-width:640px;margin:0 auto;padding:40px 0 72px}
.legal h1{margin-bottom:10px;font-size:clamp(36px,5vw,48px)}
.summary{margin:0;font-style:italic;color:#a3a29d}
.updated{margin:14px 0 28px;color:#6f6e6a;font:12px system-ui,sans-serif}
section{margin-top:36px;padding-top:28px;border-top:1px solid #ecebe61f}
section:first-of-type{margin-top:32px}
h2{margin:0 0 12px;font-size:23px;font-style:italic;font-weight:400}
p,ul{margin:0 0 14px;color:#a3a29d;font-size:17px;line-height:1.6}
strong{color:#f8f8f4;font-weight:500}
ul{padding-left:20px}
li{margin:0 0 8px}
footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:24px 0 32px;border-top:1px solid #ecebe61f;color:#6f6e6a;font:13px system-ui,sans-serif}
footer nav a{text-decoration:none}
footer nav a:hover{color:#f8f8f4}
footer .mark{color:#a3a29d;font-size:26px}
@media (max-width:820px){
.page{padding:0 24px}
.home main{grid-template-columns:1fr;gap:40px;padding:24px 0 56px}
.art{max-width:300px;margin:0 auto}
footer{flex-direction:column-reverse;align-items:flex-start}
}
`;

const mark = () =>
  `<a class="mark" href="/"><img src="${escapeHtml(brand.logo)}" alt="" width="20" height="20"><span>${escapeHtml(brand.name.toLowerCase())}</span></a>`;

function footer(withMark: boolean): string {
  const links: ReadonlyArray<readonly [string, string]> = [
    ...legalPages.map((page) => [page.label, page.path] as const),
    ["Contact", `mailto:${brand.site.email}`],
    ...(brand.links.source === null ? [] : [["GitHub", brand.links.source] as const]),
  ];
  const items = [
    `© 2026 ${escapeHtml(brand.name)}`,
    ...links.map(([label, href]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`),
  ];
  return `<footer><nav aria-label="Site">${items.join(" · ")}</nav>${withMark ? mark() : ""}</footer>`;
}

function document(
  title: string,
  description: string,
  kind: "home" | "legal",
  content: string,
  /** The page's own path; the 404 page has none, so nothing points search or shares at it. */
  path?: string,
): string {
  // The home page carries its mark in the footer, as a manifesto signs off; other pages lead with it.
  const header = kind === "home" ? "" : `<header>${mark()}</header>`;
  const meta = (attribute: "name" | "property", key: string, value: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(value)}">`;
  const share =
    path === undefined
      ? ""
      : `<link rel="canonical" href="${brand.site.url}${path}">${[
          meta("property", "og:type", "website"),
          meta("property", "og:site_name", brand.name),
          meta("property", "og:title", title),
          meta("property", "og:description", description),
          meta("property", "og:url", `${brand.site.url}${path}`),
          meta("property", "og:image", `${brand.site.url}/brand/hero/card.png`),
          meta("name", "twitter:card", "summary_large_image"),
        ].join("")}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="theme-color" content="#09090b"><title>${escapeHtml(title)}</title>${meta("name", "description", description)}${share}<link rel="preload" href="/brand/serif/eb-garamond.woff2" as="font" type="font/woff2" crossorigin><link rel="icon" href="${escapeHtml(brand.logo)}"><link rel="apple-touch-icon" href="${escapeHtml(brand.logo)}"><style>${style}</style></head><body><div class="page ${kind}">${header}<main>${content}</main>${footer(kind === "home")}</div></body></html>`;
}

function homePage(): string {
  const [roman, italic] = home.headline;
  // The eruption plays once on top of the loop that carries on from it, then steps aside. The
  // frames line up when both images start together; a slow load can cut the intro short. People
  // who ask for less motion get a still and download neither animation.
  const still = `<source media="(prefers-reduced-motion: reduce)" srcset="/brand/hero/volcano.png">`;
  const art = `<div class="art" aria-hidden="true"><picture>${still}<img src="/brand/hero/volcano-loop.webp" alt=""></picture><picture>${still}<img class="intro" src="/brand/hero/volcano-intro.webp" alt=""></picture></div>`;
  return document(
    brand.name,
    home.note,
    "home",
    `${art}<div><h1>${inline(roman)} <em>${inline(italic)}</em></h1><p class="lede">${inline(home.subheadline)}</p>${home.body.map((paragraph) => `<p class="lede">${inline(paragraph)}</p>`).join("")}<p class="tagline">${inline(home.tagline)}</p><a class="action" href="${escapeHtml(home.action.href)}">${escapeHtml(home.action.label)}</a><p class="note">${inline(home.note)}</p></div>`,
    "/",
  );
}

/** Each heading opens a section, set off by a hairline rule. */
function sections(blocks: readonly Block[]): string {
  let html = "";
  let open = false;
  for (const item of blocks) {
    if ("h2" in item) {
      html += `${open ? "</section>" : ""}<section>`;
      open = true;
    }
    html += block(item);
  }
  return open ? `${html}</section>` : html;
}

function legalPage(page: LegalPage): string {
  return document(
    `${page.title} · ${brand.name}`,
    page.summary,
    "legal",
    `<h1>${inline(page.title)}</h1><p class="summary">${inline(page.summary)}</p><p class="updated">Updated ${brand.site.updated}</p>${sections(page.blocks)}`,
    page.path,
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
