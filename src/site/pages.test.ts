import assert from "node:assert/strict";
import { test } from "node:test";
import { brand } from "../../brand.ts";
import { inline, sitePage } from "./pages.ts";
import { handleSite, type SiteEnv } from "./worker.ts";

// Page requests never touch the list.
const env = {} as SiteEnv;

const page = (path: string) => sitePage(path).html;
const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ");
const paths = ["/", "/privacy", "/terms", "/legal-notice"];

test("the home page says what the service does, why it asks for Google access, and links privacy", () => {
  const home = page("/");
  assert.match(text(home), /connects your agents to Gmail, Calendar and Drive with your own Google sign-in/);
  assert.match(home, /<a href="\/privacy">Privacy<\/a>/);
});

test("no page links to the app, so it stays unlisted until someone knows its address", () => {
  assert.ok(!page("/").includes(brand.host));
  assert.ok(!page("/waitlist").includes(brand.host));
  for (const path of [...paths, "/waitlist", "/pricing"]) {
    const html = page(path);
    // The legal pages still name the host they cover, in text; no page links to it.
    assert.doesNotMatch(html, new RegExp(`href="[^"]*${brand.host.replaceAll(".", "\\.")}`), path);
    assert.doesNotMatch(html, />\s*Sign in\s*</i, path);
  }
});

test("the home page offers the waiting list: one email field, one button, a hidden trap and no script", () => {
  const home = page("/");
  assert.equal(home.match(/<form /g)?.length, 1);
  assert.match(home, /<form class="join" method="post" action="\/waitlist">/);
  assert.equal(home.match(/<input [^>]*type="email"[^>]*required/g)?.length, 1);
  assert.equal(home.match(/<button /g)?.length, 1);
  assert.match(home, /<button type="submit">Join the waiting list<\/button>/);
  assert.match(home, /<div class="trap" aria-hidden="true">.*<input id="leave_empty" name="leave_empty" type="text" tabindex="-1" autocomplete="off">/);
  assert.match(home, /<label class="visually-hidden" for="email">Email address<\/label>/);
  assert.doesNotMatch(home, /<script/i);
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

test("privacy names the Limited Use commitment, complaint routes and the failed-request copies it keeps for now", () => {
  const privacy = text(page("/privacy"));
  assert.match(privacy, /including the Limited Use requirements/);
  assert.match(privacy, /Federal Data Protection and Information Commissioner \(FDPIC\)/);
  assert.match(privacy, /where EU law applies, your local supervisory authority/);
  assert.match(privacy, /When a request fails, the pool backend currently keeps the provider's error response/);
  assert.match(privacy, /rely on the EU Standard Contractual Clauses/);
  assert.match(privacy, /join the waiting list on signalbox\.run, we store your email address and when you joined/);
  assert.match(privacy, /only to invite you when it's your turn, and we don't send you anything else/);
  assert.match(privacy, /count recent attempts from each IP address for a minute\. We don't store the IP address with your email\./);
  assert.match(privacy, /To be removed from the waiting list, write to\s+info@signalbox\.run\s+from that address/);
  assert.match(privacy, /Waiting list: Cloudflare D1, restricted to the EU\./);
  assert.match(privacy, /Waiting list: until you're invited or ask to be removed\./);
  assert.match(privacy, /We don't log what your tools read or return\. A tool call waiting for your approval is stored encrypted/);
  assert.match(text(page("/terms")), /governed by Swiss law\. The courts of Zurich/);
});

test("pages carry share tags with the apex origin, and the 404 page points nowhere", () => {
  for (const path of paths) {
    const html = page(path);
    const url = `${brand.site.url}${path}`;
    assert.ok(html.includes(`<link rel="canonical" href="${url}">`), path);
    assert.ok(html.includes(`<meta property="og:url" content="${url}">`), path);
    assert.ok(html.includes(`<meta property="og:image" content="${brand.site.url}/brand/hero/card.png">`), path);
    assert.match(html, /<meta name="description" content="[^"]+">/, path);
  }
  const missing = sitePage("/pricing").html;
  assert.doesNotMatch(missing, /canonical|og:/);
  assert.match(missing, /<title>Page not found · Signalbox<\/title>/);
});

test("inline markup escapes HTML and allows only bold and links", () => {
  assert.equal(inline("<script>"), "&lt;script&gt;");
  assert.equal(inline("**a** [b](/c)"), '<strong>a</strong> <a href="/c">b</a>');
  assert.equal(inline('[x](https://e.example/"y)'), '<a href="https://e.example/&quot;y">x</a>');
  assert.equal(inline("[x](javascript:alert(1))"), "[x](javascript:alert(1))");
});

test("the worker serves pages without scripts and answers anything else with 404 or 405", async () => {
  const response = await handleSite(new Request("https://signalbox.run/privacy/"), env);
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.doesNotMatch(await response.text(), /<script/i);
  const missing = await handleSite(new Request("https://signalbox.run/pricing"), env);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("cache-control"), "no-store");
  assert.equal((await handleSite(new Request("https://signalbox.run/", { method: "POST" }), env)).status, 405);
  assert.equal(await (await handleSite(new Request("https://signalbox.run/", { method: "HEAD" }), env)).text(), "");
  const robots = await handleSite(new Request("https://signalbox.run/robots.txt"), env);
  assert.equal(robots.status, 200);
  assert.equal(await robots.text(), "User-agent: *\nAllow: /\n");
});
