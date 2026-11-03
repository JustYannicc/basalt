const fetch = globalThis.fetch;
const blocked = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);

globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (blocked.has(url.hostname)) {
    throw new Error(`Docs build requested a remote font from ${url.hostname}`);
  }
  return fetch(input, init);
};
