import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";
import { feedbackErrorCodes, feedbackLimits, feedbackScriptTag, injectFeedback } from "./ui.ts";

const script = await readFile(new URL("../../public/feedback.js", import.meta.url), "utf8");

test("the script names Signalbox and sends only the codes the server accepts", () => {
  assert.doesNotMatch(script, /executor/i);
  assert.match(script, /Signalbox/);
  const sent = new Set([...script.matchAll(/record\("([a-z0-9_]+)"\)/g)].map((match) => match[1]));
  assert.deepEqual([...sent].sort(), [...feedbackErrorCodes].sort());
  assert.match(script, new RegExp(`messageMax = ${feedbackLimits.messageMax}\\b`));
  assert.match(script, /screenshotMax = 2 \* 1024 \* 1024/);
  assert.match(script, /accept="image\/png,image\/jpeg"/);
  // Screenshots come only from the file picker or a paste; nothing renders the page itself.
  assert.doesNotMatch(script, /getDisplayMedia|html2canvas|toDataURL|drawImage|captureStream/);
});

type Sent = { path: string; body: unknown };
/** Runs the script against a stand-in window: error capture works before any page renders. */
async function page(pathname = "/acme/apps/abc123", status: unknown = { enabled: true }) {
  const sent: Sent[] = [];
  const reads: string[] = [];
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  class Element {
    localName: string; rel: string;
    constructor(localName: string, rel = "") { this.localName = localName; this.rel = rel; }
  }
  const statuses = new Map<string, number>();
  const window: Record<string | symbol, unknown> = {
    location: { pathname, origin: "https://app.example", href: `https://app.example${pathname}` },
    document: { body: null, addEventListener() {} },
    Element, Request, URL,
    addEventListener(type: string, listener: (event: unknown) => void) {
      listeners.set(type, [...listeners.get(type) ?? [], listener]);
    },
    fetch: async (input: string, init?: RequestInit) => {
      const url = new URL(input, "https://app.example");
      if (url.pathname === "/feedback/v1/status") {
        reads.push(`${init?.credentials} ${init?.cache}`);
        return status instanceof Response ? status : Response.json(status);
      }
      if (init?.body) sent.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      return new Response(null, { status: statuses.get(url.pathname) ?? 200 });
    },
  };
  window.window = window;
  const original = window.fetch;
  runInNewContext(script, window);
  await settle();
  const fire = (type: string, event: unknown) => listeners.get(type)?.forEach((listener) => listener(event));
  return { window, sent, reads, listeners, original, statuses, fire, Element, fetch: window.fetch as typeof fetch };
}
function settle() { return new Promise((resolve) => setTimeout(resolve, 0)); }

test("with feedback off the script asks once and leaves the page alone", async () => {
  for (const status of [{ enabled: false }, {}, { enabled: "true" }, new Response(null, { status: 404 })]) {
    const tab = await page("/", status);
    assert.deepEqual(tab.reads, ["same-origin no-store"]);
    assert.equal(tab.listeners.size, 0);
    assert.equal(tab.window.fetch, tab.original);
    tab.fire("error", { target: tab.window });
    await settle();
    assert.deepEqual(tab.sent, []);
  }
});

test("browser errors report a fixed code and the path, never their message or source", async () => {
  const tab = await page();
  tab.fire("error", { target: tab.window, message: "secret@example.com token=sk_live_x", filename: "https://app.example/x.js" });
  tab.fire("unhandledrejection", { reason: new Error("Bearer abc") });
  tab.fire("error", { target: new tab.Element("script") });
  tab.fire("error", { target: new tab.Element("link", "stylesheet") });
  tab.fire("error", { target: new tab.Element("img") });
  await settle();
  assert.deepEqual(tab.sent, [
    { path: "/feedback/v1/error", body: { code: "script_error", page: "/acme/apps/abc123" } },
    { path: "/feedback/v1/error", body: { code: "unhandled_rejection", page: "/acme/apps/abc123" } },
    { path: "/feedback/v1/error", body: { code: "resource_error", page: "/acme/apps/abc123" } },
  ]);
  assert.doesNotMatch(JSON.stringify(tab.sent), /secret|token|Bearer|x\.js/);
});

test("same-origin 5xx responses count, and reports stop at five per page load", async () => {
  const tab = await page();
  tab.statuses.set("/api/broken", 503);
  tab.statuses.set("/api/missing", 404);
  const response = await tab.fetch("/api/broken");
  assert.equal(response.status, 503, "the page still gets its own response");
  await tab.fetch("/api/missing");
  await tab.fetch("https://elsewhere.example/api/broken");
  await settle();
  assert.deepEqual(tab.sent.map((entry) => entry.body), [{ code: "http_5xx", page: "/acme/apps/abc123" }]);

  tab.fire("error", { target: tab.window });
  tab.fire("error", { target: tab.window });
  (tab.window.location as { pathname: string }).pathname = "/other";
  for (const type of ["error", "unhandledrejection"]) tab.fire(type, { target: tab.window });
  (tab.window.location as { pathname: string }).pathname = "/third";
  for (const type of ["error", "unhandledrejection"]) tab.fire(type, { target: tab.window });
  await settle();
  assert.equal(tab.sent.length, 5);
});

test("the feedback endpoints themselves never count as failures", async () => {
  const tab = await page();
  tab.statuses.set("/feedback/v1/submit", 500);
  await tab.fetch("/feedback/v1/submit", { method: "POST", body: "{}" });
  await settle();
  assert.deepEqual(tab.sent.map((entry) => entry.path), ["/feedback/v1/submit"]);
});

test("a second copy of the script does nothing", async () => {
  const tab = await page();
  const wrapped = tab.window.fetch;
  runInNewContext(script, tab.window);
  assert.equal(tab.window.fetch, wrapped);
  tab.fire("error", { target: tab.window });
  await settle();
  assert.equal(tab.sent.length, 1);
});

/** A stand-in for Workers' rewriter, for the cases that don't need a real parser. */
type BodyEnd = (end: { before(html: string): void }) => void;
type DocumentEnd = (end: { append(html: string): void }) => void;
class StringRewriter {
  #marker = "";
  #body: BodyEnd | undefined;
  #document: DocumentEnd | undefined;
  on(selector: string, handlers: { element(element: unknown): void }) {
    if (selector === "body") handlers.element({ onEndTag: (handler: BodyEnd) => { this.#body = handler; } });
    else this.#marker = selector;
    return this;
  }
  onDocument(handlers: { end: DocumentEnd }) { this.#document = handlers.end; return this; }
  transform(response: Response) {
    const rewrite = async () => {
      let html = await response.text();
      if (html.includes("data-signalbox-feedback")) return html;
      if (this.#marker && html.includes("</body>"))
        this.#body?.({ before: (tag) => { html = html.replace("</body>", `${tag}</body>`); } });
      else this.#document?.({ append: (tag) => { html += tag; } });
      return html;
    };
    return new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode(await rewrite())); controller.close();
    } }), response);
  }
}
const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "Content-Type": "text/html; charset=utf-8", ...init.headers } });

test("only HTML pages with a body get the tag", async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { Location: "/login", "Content-Type": "text/html" } }),
    new Response("{}", { headers: { "Content-Type": "application/json" } }),
    new Response(null, { status: 204, headers: { "Content-Type": "text/html" } }),
    html("<p>moved</p>", { status: 301, headers: { Location: "/" } }),
  ]) assert.equal(injectFeedback(response, StringRewriter), response);
  const missing = injectFeedback(html("<body>Not found</body>", { status: 404 }), StringRewriter);
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /data-signalbox-feedback><\/script><\/body>/);
});

// workerd's own HTMLRewriter, through Miniflare, when the generated toolchain is present.
const miniflare = await import("miniflare").catch(() => undefined);
test("Workers' HTMLRewriter adds exactly one tag before </body>", { skip: !miniflare && "miniflare is not installed" }, async (t) => {
  const source = stripTypeScriptTypes(await readFile(new URL("./ui.ts", import.meta.url), "utf8"));
  const worker = `import { injectFeedback } from "./ui.js";
const pages = {
  "/dashboard": ["<!doctype html><html><head><title>x</title></head><body><div id=root></div></body></html>", 200],
  "/carried": ['<html><body><script src="/feedback.js" defer data-signalbox-feedback></script></body></html>', 200],
  "/unclosed": ["<html><body><p>No closing tags", 200],
  "/missing": ["<html><body data-dashboard>Not found</body></html>", 404],
};
export default { fetch(request) {
  const [body, status] = pages[new URL(request.url).pathname];
  return injectFeedback(new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } }));
} };`;
  const runtime = new miniflare!.Miniflare({ compatibilityDate: "2026-01-01", modules: [
    { type: "ESModule", path: "worker.js", contents: worker },
    { type: "ESModule", path: "ui.js", contents: source },
  ] });
  t.after(() => runtime.dispose());
  const read = async (path: string) => {
    const response = await runtime.dispatchFetch(`http://localhost${path}`);
    return { status: response.status, text: await response.text() };
  };
  const count = (text: string) => text.split("data-signalbox-feedback").length - 1;
  const dashboard = await read("/dashboard");
  assert.ok(dashboard.text.endsWith(`<div id=root></div>${feedbackScriptTag}</body></html>`), dashboard.text);
  assert.equal(count((await read("/carried")).text), 1);
  assert.ok((await read("/unclosed")).text.endsWith(feedbackScriptTag));
  const missing = await read("/missing");
  assert.equal(missing.status, 404);
  assert.equal(count(missing.text), 1);
});
