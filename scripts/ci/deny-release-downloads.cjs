const dns = require("node:dns");
const http = require("node:http");
const https = require("node:https");
const { syncBuiltinESMExports } = require("node:module");

const denied = (host) =>
  host === "github.com" ||
  /^(?:release-assets|objects|objects-origin|github-releases)\.githubusercontent\.com$/.test(host);
const refusal = (host) => new Error(`Blocked GitHub release asset host ${host}`);
const hostOf = (input) => {
  if (typeof input === "string" || input instanceof URL) return new URL(input).hostname;
  return input.hostname ?? input.host?.split(":")[0];
};

for (const protocol of [http, https]) {
  for (const method of ["request", "get"]) {
    const original = protocol[method];
    protocol[method] = function (input, ...args) {
      const host = hostOf(input);
      if (denied(host)) throw refusal(host);
      return original.call(this, input, ...args);
    };
  }
}
const fetch = globalThis.fetch;
globalThis.fetch = async (input, ...args) => {
  const host = new URL(input instanceof Request ? input.url : input).hostname;
  if (denied(host)) throw refusal(host);
  return fetch(input, ...args);
};

// Undici can open sockets without calling node:http or the global fetch function.
const lookup = dns.lookup;
dns.lookup = function (host, ...args) {
  if (denied(host)) throw refusal(host);
  return lookup.call(this, host, ...args);
};
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = async function (host, ...args) {
  if (denied(host)) throw refusal(host);
  return lookupPromise.call(this, host, ...args);
};
syncBuiltinESMExports();
