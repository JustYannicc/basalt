import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { inline, sitePage } from "./pages.ts";
import { handleSite } from "./worker.ts";

const page = (path: string) => sitePage(path).html;
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
const paths = ["/", "/privacy", "/terms", "/legal-notice"];

test("the home page says what the service does, why it asks for Google access, and links privacy", () => {
  const home = page("/");
  assert.match(text(home), /connects your agents to Gmail, Calendar and Drive with your own Google sign-in/);
  assert.match(home, /<a href="\/privacy">Privacy<\/a>/);
  assert.match(home, new RegExp(`<a class="action" href="https://${brand.host}">Sign in</a>`));
  assert.equal(home.match(/class="action"/g)?.length, 1);
});

test("every page carries the footer: copyright, legal pages, contact and source", () => {
  for (const path of paths) {
    const html = page(path);
    assert.match(html, /© 2026 Signalbox/, path);
    for (const href of ["/privacy", "/terms", "/legal-notice", `mailto:${brand.site.email}`, brand.links.source!])
      assert.ok(html.includes(`href="${href}"`), `${path} links ${href}`);
  }
});

test("the operator is named by entity, region and email only, with no placeholder left", () => {
  for (const path of ["/privacy", "/terms"])
    assert.match(text(page(path)), /operated by Signalbox, Zurich, Switzerland/, path);
  assert.match(text(page("/legal-notice")), /Signalbox\s+Zurich, Switzerland\s+info@signalbox\.run/);
  for (const path of paths) {
    assert.doesNotMatch(page(path), /\[[A-Z][A-Z ]+\]/, `${path} has a placeholder`);
    assert.doesNotMatch(page(path), /support@|commercial-mode/i, path);
  }
});

test("privacy names the Limited Use commitment, complaint routes and metadata-only failure records", () => {
  const privacy = text(page("/privacy"));
  assert.match(privacy, /including the Limited Use requirements/);
  assert.match(privacy, /Federal Data Protection and Information Commissioner \(FDPIC\)/);
  assert.match(privacy, /where EU law applies, your local supervisory authority/);
  assert.match(privacy, /When a request fails, the pool backend currently keeps the provider's error response/);
  assert.match(privacy, /rely on the EU Standard Contractual Clauses/);
  assert.match(text(page("/terms")), /governed by Swiss law\. The courts of Zurich/);
});

test("inline markup escapes HTML and allows only bold and links", () => {
  assert.equal(inline("<script>"), "&lt;script&gt;");
  assert.equal(inline("**a** [b](/c)"), '<strong>a</strong> <a href="/c">b</a>');
  assert.equal(inline('[x](https://e.example/"y)'), '<a href="https://e.example/&quot;y">x</a>');
  assert.equal(inline("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
});

test("the worker serves pages without scripts and answers anything else with 404 or 405", async () => {
  const response = handleSite(new Request("https://signalbox.run/privacy/"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.doesNotMatch(await response.text(), /<script/i);
  const missing = handleSite(new Request("https://signalbox.run/pricing"));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal(handleSite(new Request("https://signalbox.run/", { method: "POST" })).status, 405);
  assert.equal(await handleSite(new Request("https://signalbox.run/", { method: "HEAD" })).text(), "");
});
