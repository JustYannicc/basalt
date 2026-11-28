import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { routePeerInstallMs } from "./route-peer-intercept.ts";

// Real workerd, the real runtime transport a cell's start awaits and PoolWorker's real exports; only
// the container is fake. Its home-peer intercept answers at once, its route-peer one as the path says.
const fixture = `
import { RuntimeHomePeerTransport } from './src/pool/home-peer.worker.ts';
import * as main from './src/pool/worker.ts';
// The platform's ctx.exports: one loopback factory per entrypoint PoolWorker's main module exports.
const exported = Object.fromEntries(Object.keys(main).map((name) => [name, () => name]));
export default { async fetch(request) {
  const [kind, mode] = new URL(request.url).pathname.slice(1).split('/');
  const hosts = [];
  const lines = [];
  const background = [];
  const error = console.error;
  console.error = (...args) => { lines.push(args.join(' ')); error(...args); };
  const ctx = {
    id: { toString: () => 'instance' },
    storage: {},
    exports: exported,
    waitUntil: (work) => background.push(work),
    container: {
      interceptOutboundHttp: (host) => {
        hosts.push(host);
        if (host === 'home-peer.internal' || mode === 'answer') return Promise.resolve();
        if (mode === 'hang') return new Promise(() => {});
        return Promise.reject(new Error('intercept refused'));
      },
    },
  };
  const source = kind === 'legacy'
    ? { kind: 'legacy', identity: { controllerId: 'controller' } }
    : { kind: 'runtime', witness: { target: { controllerId: 'controller' } } };
  try {
    const install = new RuntimeHomePeerTransport(ctx, 'k'.repeat(64), async () => ({})).install(source);
    // Whether the install itself returned within a second, before its route intercept settled.
    const first = await Promise.race([
      install.then(() => 'installed'),
      new Promise((resolve) => setTimeout(() => resolve('held'), 1000)),
    ]);
    await install;
    await Promise.all(background);
    return Response.json({ first, hosts, lines });
  } finally {
    console.error = error;
  }
} };
`;

async function start() {
  const bundle = await build({
    stdin: {
      contents: fixture,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "module", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
    plugins: [
      {
        name: "unavailable-database",
        setup(build) {
          build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "unavailable" }));
          build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({
            contents:
              "export default { Pool: class { constructor(){ throw Error('An intercept install must not query a database'); } } };",
          }));
        },
      },
    ],
  });
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      outboundService: () => new Response(null, { status: 403 }),
    }),
  );
}

test("a cell's start gets past a route intercept that answers, throws or never answers, home-peer intercept first", { timeout: 60_000 }, async (context) => {
  const mf = await start();
  context.after(() => mf.dispose());
  const install = async (kind: string, mode: string) => {
    const started = performance.now();
    const answer = (await (await mf.dispatchFetch(`http://fixture/${kind}/${mode}`)).json()) as {
      first: string;
      hosts: string[];
      lines: string[];
    };
    return { ...answer, waited: performance.now() - started };
  };
  const pendingLine = "POOL_ROUTE_PEER_INTERCEPT_PENDING";
  for (const kind of ["runtime", "legacy"]) {
    const answered = await install(kind, "answer");
    assert.deepEqual(answered.hosts, ["home-peer.internal", "route-peer.internal"], kind);
    assert.deepEqual([answered.first, answered.lines], ["installed", []], kind);
    const thrown = await install(kind, "throw");
    assert.deepEqual(thrown.hosts, ["home-peer.internal", "route-peer.internal"], kind);
    assert.deepEqual([thrown.first, thrown.lines], ["installed", [pendingLine]], kind);
  }
  // A fleet cell's start waits the bound and no longer: it goes on with routed credentials refused.
  const cell = await install("runtime", "hang");
  assert.deepEqual(cell.hosts, ["home-peer.internal", "route-peer.internal"]);
  assert.deepEqual([cell.first, cell.lines], ["held", [pendingLine]]);
  assert.ok(
    cell.waited >= routePeerInstallMs - 100 && cell.waited < routePeerInstallMs + 5_000,
    String(cell.waited),
  );
  // The root's recovery bootstrap has 2 s: there the hung route intercept never holds the install.
  const root = await install("legacy", "hang");
  assert.deepEqual(root.hosts, ["home-peer.internal", "route-peer.internal"]);
  assert.deepEqual([root.first, root.lines], ["installed", [pendingLine]]);
});
