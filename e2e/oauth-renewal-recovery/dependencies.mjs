import { createRequire } from "node:module";

// Resolve the same Effect instance as the pinned e2e SDK, rather than root tooling's copy.
const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
export const { Context, Effect, Layer, Redacted } = await import(require.resolve("effect"));
export const NodeServices = await import(require.resolve("@effect/platform-node/NodeServices"));
export const { FetchHttpClient, HttpClient } = await import(require.resolve("effect/http"));
