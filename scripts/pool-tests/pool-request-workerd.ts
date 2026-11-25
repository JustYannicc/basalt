// The container's ports and the telemetry hosts are synthetic, and there is no account database, so
// model history is off. The Worker entry, the hop to the pool's Durable Object, admission, forwarding
// and both drains are real.
export const poolRequestWorkerd = `
import { DurableObject } from 'cloudflare:workers';
import { PoolContainer, handlePoolWorkerRequest } from './src/pool/worker.ts';
const bootId = '11111111-1111-4111-8111-111111111111';
const events = [];
const info = console.info;
console.info = (...values) => {
  if (values[0] && typeof values[0] === 'object' && values[0].service === 'basalt-pool') events.push(values[0]);
  else info(...values);
};
const text = new TextEncoder();
function environment(env) {
  return { ...env, PoolContainer: { jurisdiction: () => env.Root } };
}
function container() {
  return { running: true, async start() {}, async destroy() {}, async setInactivityTimeout() {},
    monitor: () => new Promise(() => {}),
    getTcpPort(port) {
      if (port === 8318) return { fetch: async () => Response.json(
        { boot_id: bootId, started_at: '2026-01-01T00:00:00Z' },
        { headers: { 'X-Signalbox-Policy-Lease-Ms': '1500' } }) };
      if (port !== 8317) throw Error('Wrong pool port');
      return { fetch: async (request) => {
        const sent = await request.text();
        // The runtime answers after Home's dispatch and the provider's first byte.
        await scheduler.wait(40);
        return new Response(text.encode(JSON.stringify({ echoed: sent.length, secret: 'synthetic-response-content' })), {
          headers: { 'Content-Type': 'application/json', 'X-Signalbox-Pool-Boot': bootId,
            'X-Signalbox-Pool-Dispatch-Timing': JSON.stringify([
              { stage: 'authenticate', duration_ms: 3, outcome: 'ok' },
              { stage: 'selection', duration_ms: 5, outcome: 'ok' },
              { stage: 'rpop', duration_ms: 21, outcome: 'timeout' } ]) } });
      } };
    } };
}
export class Root extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    Object.defineProperty(ctx, 'container', { value: container() });
    this.inner = new PoolContainer(ctx, environment(env));
  }
  fetch(request) {
    if (new URL(request.url).searchParams.has('crash')) throw Error('synthetic-controller-failure');
    return this.inner.fetch(request);
  }
  alarm() { return this.inner.alarm(); }
  // Returns once the object is busy, so the next request is certain to wait for it.
  occupy(milliseconds) { this.ctx.blockConcurrencyWhile(() => scheduler.wait(milliseconds)); }
}
export default { async fetch(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === '/__events') return Response.json(events);
  const occupied = url.searchParams.get('occupied');
  if (occupied) await env.Root.getByName('control-plane').occupy(Number(occupied));
  const lookup = Number(url.searchParams.get('lookup') ?? 0);
  try {
    return await handlePoolWorkerRequest(request, environment(env), async () => {
      if (lookup) await scheduler.wait(lookup);
      return true;
    }, work => ctx.waitUntil(work));
  } catch {
    return new Response(null, { status: 502 });
  }
} };
`;
