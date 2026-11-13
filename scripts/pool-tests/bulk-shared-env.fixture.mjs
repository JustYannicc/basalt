import { env as nativeEnvironment } from "cloudflare:workers";
export * from "cloudflare:workers";

const hidden = new Set([
  "POOL_APP_SIGNING_KEY",
  "POOL_APP_SIGNING_KEY_PREVIOUS",
  "POOL_AUTH_DATABASE",
  "TOOLS_SERVICE",
]);
const reads = Object.fromEntries([...hidden].map((key) => [key, 0]));
let artifactReads = 0;
let jurisdictionCalls = 0;
let nativeIdCalls = 0;
let namespace;

// Local workerd has no jurisdiction routing. Every ID and stub still comes from its real namespace.
const localEuNamespace = () => {
  if (namespace) return namespace;
  const raw = nativeEnvironment.ArtifactsTokenCoordinator;
  namespace = new Proxy(Object.create(null), {
    get(_target, key) {
      if (key === "jurisdiction")
        return (region) => {
          if (region !== "eu") throw new Error("The shared coordinator must select eu");
          jurisdictionCalls++;
          return namespace;
        };
      if (key === "idFromName")
        return (name) => {
          nativeIdCalls++;
          return raw.idFromName(name);
        };
      const value = Reflect.get(raw, key);
      return typeof value === "function" ? value.bind(raw) : value;
    },
  });
  return namespace;
};

// Reproduce importable env's lazy property access without relying on enumerable binding keys.
export const env = new Proxy(Object.create(null), {
  get(_target, key) {
    if (hidden.has(key)) reads[key]++;
    if (key === "AppSources" || key === "Vaults") {
      artifactReads++;
      throw new Error("Denied Source or vault operation reached its Artifacts binding");
    }
    if (key === "ArtifactsTokenCoordinator") return localEuNamespace();
    return Reflect.get(nativeEnvironment, key);
  },
  has(_target, key) {
    return key in nativeEnvironment;
  },
  ownKeys() {
    return Reflect.ownKeys(nativeEnvironment).filter((key) => !hidden.has(key));
  },
  getOwnPropertyDescriptor(_target, key) {
    if (!(key in nativeEnvironment)) return undefined;
    return { configurable: true, enumerable: !hidden.has(key), get: () => env[key] };
  },
});

export const environmentObservation = () => ({
  hiddenKeys: [...hidden],
  enumerableKeys: Object.keys(env),
  reads: { ...reads },
  artifactReads,
  jurisdictionCalls,
  nativeIdCalls,
});
