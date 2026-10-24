import { parse, stringify } from "smol-toml";

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = (value) => value === undefined ? undefined : structuredClone(value);
export const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function decode(source, format) {
  const value = source ? format === "toml" ? parse(source) : JSON.parse(source) : {};
  if (!record(value)) throw new Error("The config must contain an object.");
  return value;
}
export function encode(value, format) {
  return format === "toml" ? stringify(value) : `${JSON.stringify(value, null, 2)}\n`;
}
function valueAt(root, path) {
  return path.reduce((value, key) => record(value) ? value[key] : undefined, root);
}
function writeAt(root, path, value) {
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (target[key] === undefined) target[key] = {};
    if (!record(target[key])) throw new Error(`Expected a table at ${path.join(".")}.`);
    target = target[key];
  }
  if (value === undefined) delete target[path.at(-1)];
  else target[path.at(-1)] = copy(value);
}

/** Record the previous value for every leaf we own, including overwritten proxy settings. */
export function apply(source, format, entries, previous = []) {
  const value = decode(source, format);
  const changes = [];
  for (const [path, installed] of entries) {
    const old = previous.find((change) => equal(change.path, path));
    changes.push({ path, before: copy(old ? old.before : valueAt(value, path)), after: copy(installed) });
    writeAt(value, path, installed);
  }
  return { source: encode(value, format), changes };
}

/** Preserve subsequent user edits. An untouched file is restored from its byte backup instead. */
export function remove(source, format, changes) {
  const value = decode(source, format);
  for (const change of [...changes].reverse()) {
    if (equal(valueAt(value, change.path), change.after)) writeAt(value, change.path, change.before);
  }
  return encode(value, format);
}

export function clientEntries(credentials, brand) {
  const name = brand.mcpServerName;
  const marker = { id: brand.setup.id, text: brand.setup.marker };
  return {
    claude: [
      [["env", "ANTHROPIC_BASE_URL"], credentials.modelUrl],
      [["env", "ANTHROPIC_AUTH_TOKEN"], credentials.modelKey],
      [["env", "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY"], "1"],
      [["env", "CLAUDE_CODE_GATEWAY_MODEL_DISCOVERY_TIMEOUT_MS"], "60000"],
      [["env", "API_TIMEOUT_MS"], "600000"],
      [[brand.setup.id], marker],
    ],
    claudeMcp: [
      [["mcpServers", name], { type: "http", url: credentials.toolsUrl, headers: { Authorization: `Bearer ${credentials.toolsToken}` } }],
      [[brand.setup.id], marker],
    ],
    codex: [
      [["model_provider"], name],
      [["model_providers", name], { name: brand.name, base_url: `${credentials.modelUrl}/v1`, wire_api: "responses", requires_openai_auth: true, http_headers: { "X-Api-Key": credentials.modelKey } }],
      [["mcp_servers", name], { url: credentials.toolsUrl, http_headers: { Authorization: `Bearer ${credentials.toolsToken}` } }],
      [[brand.setup.id], marker],
    ],
  };
}
