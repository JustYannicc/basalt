import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const slackHost = /^(?:[a-z0-9-]+\.)*slack\.com$/i;

export async function readSlackPackage(root) {
  const path = join(root, "src/catalog/slack.json");
  const source = JSON.parse(await readFile(path, "utf8"));
  assert.equal(source.package, "@executor.sh/slack", "The maintained Slack package changed");
  assert.ok(Array.isArray(source.files) && source.files.length > 0, "Slack package files are required");
  for (const file of source.files) {
    assert.equal(typeof file.path, "string", "Every Slack file needs a path");
    assert.equal(typeof file.content, "string", `Slack file ${file.path} needs content`);
  }
  const names = source.files.map((file) => file.path);
  assert.equal(new Set(names).size, names.length, "Slack package file paths must be unique");
  assert.ok(names.includes("index.ts"), "Slack index.ts is missing");
  assert.ok(names.includes("openapi.ts"), "Slack openapi.ts is missing");
  assert.ok(names.includes("package.json"), "Slack package.json is missing");
  return source;
}

export function openapiSpecUrl(source) {
  const file = source.files.find((item) => item.path === "openapi.ts");
  const match = file?.content.match(/source\s*:\s*\{\s*url\s*:\s*["']([^"']+)["']/s);
  assert.ok(match?.[1], "Slack OpenAPI source URL is missing");
  return match[1];
}

function localSlackUrl(value, localOrigin) {
  const url = new URL(value);
  if (!slackHost.test(url.hostname)) return value;
  return new URL(`${url.pathname}${url.search}${url.hash}`, localOrigin).href;
}

function rewrite(content, pattern, replacement) {
  let count = 0;
  const result = content.replace(pattern, (...args) => {
    count++;
    return replacement(...args);
  });
  return { content: result, count };
}

/** Copy the catalog package and change only its network destinations. */
export function localSlackPackage(source, localOrigin, specUrl) {
  const localHost = new URL(localOrigin).host;
  const changed = [];
  const files = source.files.map((file) => {
    let content = file.content;
    if (file.path === "index.ts") {
      const auth = rewrite(content,
        /(authorizationUrl\s*:\s*["'])(https?:\/\/[^"']+)(["'])/g,
        (_whole, prefix, url, suffix) => prefix + localSlackUrl(url, localOrigin) + suffix);
      content = auth.content;
      const token = rewrite(content,
        /(tokenUrl\s*:\s*["'])(https?:\/\/[^"']+)(["'])/g,
        (_whole, prefix, url, suffix) => prefix + localSlackUrl(url, localOrigin) + suffix);
      content = token.content;
      const health = rewrite(content,
        /https:\/\/slack\.com\/api\/(?:auth\.test|users\.profile\.get)/g,
        (url) => localSlackUrl(url, localOrigin));
      content = health.content;
      const hosts = rewrite(content,
        /(hosts\s*:\s*\[[^\]]*?)(["'])(?:\*\.)?(?:[a-z0-9-]+\.)*slack\.com\2/gi,
        (_whole, prefix, quote) => prefix + quote + localHost + quote);
      content = hosts.content;
      assert.ok(auth.count > 0, "Slack OAuth authorization URL was not localized");
      assert.ok(token.count > 0, "Slack OAuth token URL was not localized");
      assert.ok(health.count > 0, "Slack health destination was not localized");
      assert.ok(hosts.count > 0, "Slack provider host allowlist was not localized");
      changed.push({ path: file.path, auth: auth.count, token: token.count, health: health.count, hosts: hosts.count });
    } else if (file.path === "openapi.ts") {
      const allowedOrigin = rewrite(content,
        /(allowedOrigin\s*:\s*["'])(https?:\/\/[^"']+)(["'])/g,
        (_whole, prefix, url, suffix) => prefix + new URL(localSlackUrl(url, localOrigin)).origin + suffix);
      content = allowedOrigin.content;
      const sourceUrl = rewrite(content,
        /(source\s*:\s*\{\s*url\s*:\s*["'])([^"']+)(["'])/s,
        (_whole, prefix, _url, suffix) => prefix + specUrl + suffix);
      content = sourceUrl.content;
      assert.equal(allowedOrigin.count, 1, "Slack OpenAPI allowedOrigin must be changed once");
      assert.equal(sourceUrl.count, 1, "Slack OpenAPI source must point at the local fixture");
      changed.push({ path: file.path, allowedOrigin: allowedOrigin.count, openapiSource: sourceUrl.count });
    }
    return { ...file, content };
  });
  assert.equal(changed.length, 2, "Only Slack index.ts and openapi.ts network destinations should change");
  return { source: { package: source.package, files }, changed };
}

export function originalNetworkDestinations(source) {
  const content = source.files.map((file) => `${file.path}\n${file.content}`).join("\n");
  const urls = [...content.matchAll(/https?:\/\/[^\s"'`<>]+/g)].map((match) => match[0].replace(/[),;]+$/, ""));
  return [...new Set(urls.filter((value) => {
    try { return slackHost.test(new URL(value).hostname); } catch { return false; }
  }))];
}

export function slackCatalogEntry(source) {
  const manifest = JSON.parse(source.files.find((file) => file.path === "package.json").content);
  const iconFile = source.files.find((file) => file.path === "icon.ts")?.content ?? "";
  const icons = [...iconFile.matchAll(/"src"\s*:\s*"(data:image\/[^\"]+)"/g)]
    .map((match) => ({ src: match[1], mimeType: "image/svg+xml" }));
  return {
    id: "slack",
    package: source.package,
    name: manifest.executor?.title ?? "Slack",
    description: manifest.description ?? "",
    auth: [
      { method: "oauth", kind: "oauth2" },
      { method: "token", kind: "secrets", label: "Bot or user token (xoxb-/xoxp-)" },
    ],
    icons,
    source: "apps/slack.json",
  };
}

export function assertSourceKeepsSlackTools(source) {
  const index = source.files.find((file) => file.path === "index.ts")?.content ?? "";
  const openapi = source.files.find((file) => file.path === "openapi.ts")?.content ?? "";
  assert.match(index, /liveOpenapiRouter\(/, "Slack tools must keep the maintained OpenAPI router");
  assert.match(index, /withApprovals\(/, "Slack tools must keep the maintained approval wrapper");
  assert.match(index, /auth\.test/, "Slack health mapping must remain in the maintained app");
  assert.match(openapi, /conversations\.history/, "Slack OpenAPI fixture must include conversations.history");
  assert.match(openapi, /chat\.postMessage/, "Slack OpenAPI fixture must include chat.postMessage");
}

export function slackUserMethod(source) {
  const index = source.files.find((file) => file.path === "index.ts")?.content ?? "";
  const start = index.indexOf("user: oauth2({");
  assert.notEqual(start, -1, "Slack user OAuth method is missing");
  const end = index.indexOf("\n    }),\n    token", start);
  assert.notEqual(end, -1, "Slack user OAuth method shape changed");
  const method = index.slice(start, end);
  const authorizationUrl = method.match(/authorizationUrl\s*:\s*["']([^"']+)["']/)?.[1];
  const tokenUrl = method.match(/tokenUrl\s*:\s*["']([^"']+)["']/)?.[1];
  const scopes = index.match(/const userScopes\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(authorizationUrl && tokenUrl, "Slack user OAuth endpoints are missing");
  assert.ok(scopes, "Slack user scope list is missing");
  const scopeList = [...scopes[1].matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
  assert.ok(scopeList.length > 0, "Slack user_scope list cannot be empty");
  assert.match(method, /scopes\s*:\s*\[\s*\]/, "Slack user OAuth must declare no bot scopes");
  assert.match(method, /authorizationParams\s*:\s*\{[^}]*user_scope\s*:\s*userScopes\.join\(["'],["']\)/s,
    "Slack user OAuth must send the maintained user_scope list");
  assert.match(method, /tokenResponse\s*:\s*\{[^}]*path\s*:\s*["']authed_user["'][^}]*requiredOnExchange\s*:\s*true/s,
    "Slack user OAuth must require its nested grant during exchange");
  return { authorizationUrl, tokenUrl, userScopes: scopeList, userScope: scopeList.join(",") };
}

/** Read a published framework release through the same registry the app compiler will use. */
export async function inspectPublishedAppsRelease(registryUrl, version) {
  const response = await fetch(`${registryUrl.replace(/\/$/, "")}/apps`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, "The forwarding npm registry did not return apps metadata");
  const metadata = await response.json();
  const release = metadata.versions?.[version];
  assert.ok(release, `The forwarding npm registry did not return apps@${version}`);
  assert.equal(release.version, version);

  const tarball = new URL(release.dist?.tarball);
  assert.equal(tarball.origin, "https://registry.npmjs.org", "The published apps tarball origin changed");
  const archiveResponse = await fetch(tarball, { signal: AbortSignal.timeout(60_000) });
  assert.equal(archiveResponse.status, 200, `Could not fetch the published apps@${version} archive`);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  assert.equal(integrity, release.dist.integrity, `apps@${version} archive did not match npm integrity`);

  const packageJson = JSON.parse(execFileSync("tar", ["-xzOf", "-", "package/package.json"], {
    input: archive,
    encoding: "utf8",
  }));
  assert.equal(packageJson.version, version, `The published apps archive was not version ${version}`);
  const protocolSource = execFileSync("tar", ["-xzOf", "-", "package/types/apps/src/contracts/protocol-version.d.ts"], {
    input: archive,
    encoding: "utf8",
  });
  const frameworkProtocol = Number(protocolSource.match(/frameworkProtocol\s*=\s*(\d+)/)?.[1]);
  assert.ok(Number.isInteger(frameworkProtocol) && frameworkProtocol > 0,
    `apps@${version} did not publish a framework protocol number`);
  return { version, frameworkProtocol, integrity, tarballOrigin: tarball.origin };
}
