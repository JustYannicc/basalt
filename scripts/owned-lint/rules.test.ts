import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { severity, type Config } from "./baseline.ts";
import { lint } from "./check.ts";

// Each case is linted by the real oxlint with the real configuration. A line ending in
// `// expect: <rules>` must report exactly those rules of its suite; every other line must report
// none of them.
// Cases marked "production" quote the shipped line verbatim.
const cases = {
  // production: scripts/release-barrier/class-cloudflare.ts:99 at b96514294^ (failed releases 14 and 15,
  // a JSON body on a GET, refused by fetch as an opaque TransportError).
  "scripts/release/class-read.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect } from "effect";
export const readDeclaredClass = (target: { accountId: string; scriptName: string }) =>
  Effect.gen(function* () {
    const versionId = "v";
    const version = yield* Workers.getScriptVersion({ ...target, versionId }).pipe(Retry.none); // expect: basalt/no-spread-into-provider-request, basalt/no-direct-cloudflare-api
    return version;
  });
`,
  // The fix from #1359: named fields only.
  "scripts/release/class-read-fixed.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
export const read = (target: { accountId: string; scriptName: string }, versionId: string) =>
  Workers.getScriptVersion({ accountId: target.accountId, scriptName: target.scriptName, versionId }); // expect: basalt/no-direct-cloudflare-api
`,
  "scripts/release/whole-object.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
export const read = (target: { accountId: string; scriptName: string; files: unknown[] }) =>
  Workers.getScript(target); // expect: basalt/no-direct-cloudflare-api, basalt/no-spread-into-provider-request
export const typed = (accountId: string, scriptName: string) => {
  const request: Workers.GetScriptRequest = { accountId, scriptName };
  return Workers.getScript(request); // expect: basalt/no-direct-cloudflare-api
};
`,
  // production: scripts/release-barrier/class-payload.ts:131 and :152 at 1d75a5f1 (the settings
  // read's provider-managed annotation echoed into the strict PUT metadata).
  "scripts/release/class-payload.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
export function expansionRequest(settings: { annotations?: Record<string, string> }, marker: string) {
  const withoutNull = (value: unknown) => value;
  const metadata = Schema.decodeUnknownSync(Schema.toType(Workers.PutScriptMetadata), {
    onExcessProperty: "error",
  })(
    withoutNull({
      annotations: { ...settings.annotations, workersMessage: marker }, // expect: basalt/no-spread-into-provider-request
    }),
  );
  return metadata;
}
export const deploy = (request: Workers.PutScriptRequest) => Workers.putScript(request); // expect: basalt/no-direct-cloudflare-api
`,
  // production: scripts/release-barrier/class-settings.ts:79 at 1d75a5f1 (strict decode of a settings response).
  "scripts/release/class-settings.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { Schema } from "effect";
export const decodeSettings = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.toType(Workers.GetScriptScriptAndVersionSettingResponse), {
    onExcessProperty: "error", // expect: basalt/no-strict-provider-decode
    errors: "all",
  })(value);
export const lenient = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.toType(Workers.GetScriptScriptAndVersionSettingResponse))(value);
`,
  // production: scripts/release-barrier/provisioning-refusal.ts:13 at 1d75a5f1 (the strict helper behind
  // decodeCreatedRuntime, which refused Cloudflare's new configuration.runtime key).
  "scripts/release/provisioning-refusal.ts": `
import { Schema } from "effect";
export function decodeProvisioningInput<A>(schema: Schema.Codec<A>) {
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error", errors: "all" }); // expect: basalt/no-strict-provider-decode
}
export const ownRecord = (schema: Schema.Codec<unknown>) => Schema.decodeUnknownSync(schema, { onExcessProperty: "ignore" });
`,
  // production: scripts/release-barrier/class-clone.ts:106 at 1d75a5f1 (Cloudflare stamps and
  // normalises the clone, so the exact compare refused and wedged the rerun).
  "scripts/release/class-clone.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { canonical } from "./manifest.ts";
const withoutNull = (value: unknown) => value;
export function assertClone(expected: unknown, actual: Workers.GetBetaWorkerVersionResponse | undefined) {
  const observed = actual && { annotations: actual.annotations };
  if (!actual || canonical(withoutNull(expected)) !== canonical(withoutNull(observed))) throw new Error("mismatch"); // expect: basalt/no-exact-readback-compare
  const sent = canonical(expected);
  if (sent !== canonical(observed)) throw new Error("mismatch"); // expect: basalt/no-exact-readback-compare
  const readBack = JSON.stringify(observed);
  return sent === readBack; // expect: basalt/no-exact-readback-compare
}
`,
  // production: scripts/release-barrier/runtime-provisioning.ts:154 at 1d75a5f1 (the created
  // application's resolved configuration never equals the request).
  "scripts/release/runtime-provisioning.ts": `
import { sameProvisioningValue } from "./provisioning-refusal.ts";
export async function bootstrap(provider: { readApplication(id: string): Promise<{ configuration: unknown }> }, image: string) {
  const application = await provider.readApplication("id");
  sameProvisioningValue("application.configuration", { image, instanceType: "basic" }, application.configuration); // expect: basalt/no-exact-readback-compare
}
`,
  // production: scripts/release-barrier/class-native.ts:37 at 1d75a5f1 (two writers record
  // the class list differently).
  "scripts/release/class-native.ts": `
import { State } from "alchemy/State/State";
import { canonical } from "./manifest.ts";
export const drifted = (current: { attr: { durableObjectNamespaces: unknown } }, saved: unknown) =>
  State !== undefined &&
  canonical(current.attr.durableObjectNamespaces) !== // expect: basalt/no-exact-readback-compare
    canonical(saved);
`,
  // Our own records compared in a file that talks to no provider are not read-backs.
  "scripts/journal.ts": `
import { canonical } from "./manifest.ts";
export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
`,
  // The way out: a named equivalence helper, proven against a recorded read-back.
  "scripts/release/clone-equivalence.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
export function cloneEquivalent(sent: { mainModule: string }, readBack: Workers.GetBetaWorkerVersionResponse) {
  return JSON.stringify(sent.mainModule) === JSON.stringify(readBack.mainModule);
}
`,
  "scripts/release/clone-equivalence.test.ts": `
import { recordedClone } from "./clone-shapes.ts";
import { cloneEquivalent } from "./clone-equivalence.ts";
export const proven = cloneEquivalent({ mainModule: "worker.js" }, recordedClone);
`,
  "scripts/release/clone-shapes.ts": `
export const recordedClone = { id: "version", mainModule: "worker.js", annotations: { "workers/triggered_by": "version_upload" } };
`,
  // A comment naming a shapes module, or an import of one that does not exist, is not a proof.
  "scripts/release/settings-equivalence.ts": `// expect: basalt/no-exact-readback-compare
export function settingsEquivalent(sent: string, readBack: string) {
  return fetch(sent) !== undefined && JSON.stringify(sent) === JSON.stringify(readBack);
}
`,
  "scripts/release/settings-equivalence.test.ts": `
// from "./clone-shapes.ts"
import { recordedSettings } from "./missing-shapes.ts";
export const used = recordedSettings;
`,
  "scripts/release/unproven-equivalence.ts": `// expect: basalt/no-exact-readback-compare
export function settingsEquivalent(sent: string, readBack: string) {
  return fetch(sent) !== undefined && JSON.stringify(sent) === JSON.stringify(readBack);
}
`,
  // An echo stub hides read-then-echo and write-then-compare bugs; a hand-written body hides shape drift.
  "scripts/release/test/application-stand-in.ts": `
import { createServer } from "node:http";
declare function readBody(request: unknown): Promise<string>;
export const server = createServer(async (request, response) => {
  const body = JSON.parse(await readBody(request));
  response.end(
    JSON.stringify({ // expect: basalt/no-handwritten-provider-response
      success: true,
      errors: [],
      result: { ...body, id: "application" }, // expect: basalt/no-echo-stub
    }),
  );
});
`,
  "scripts/release/test/fetch-stand-in.test.ts": `
export const fetcher = async (_input: string, init: { body: string }) => {
  const sent = JSON.parse(init.body);
  return Response.json({ result: sent }); // expect: basalt/no-echo-stub
};
`,
  // production: scripts/release-barrier/test/production-pool-worker.ts:207 at 1d75a5f1, the stand-in that
  // hid the clone compare failure: the clone is stored as posted and served back on the read.
  "scripts/release/test/stored-stand-in.ts": `
import assert from "node:assert/strict";
const clones = new Map<string, unknown>();
export async function respond(method: string, body: () => Promise<unknown>) {
  if (method === "POST") {
    const clone = (await body()) as Record<string, unknown>;
    assert.deepEqual({ ...clone }, { mainModule: "worker.js" });
    clones.set("clone-1", { ...clone, id: "clone-1" }); // expect: basalt/no-echo-stub
  }
  return clones.get("clone-1");
}
`,
  // production: scripts/release-barrier/test/provisioning-provider-proof.mjs:189 at 1d75a5f1, the stand-in
  // that hid the created-application compare and the configuration.runtime refusal.
  "scripts/release/test/created-stand-in.ts": `
export const client = (request: { method: string; body: { _tag: string; body: Uint8Array } }) => {
  const body =
    request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined;
  let result;
  if (request.method === "POST")
    result = {
      id: "synthetic-created-app",
      version: 1,
      ...body, // expect: basalt/no-echo-stub
    };
  return result;
};
`,
  "scripts/release/test/recorded-stand-in.ts": `
import { createServer } from "node:http";
import { recordedApplication } from "./application-shapes.ts";
export const server = createServer((_request, response) => response.end(JSON.stringify(recordedApplication)));
`,
  "scripts/release/test/application-shapes.ts": `
export const recordedApplication = { success: true, errors: [], messages: [], result: { id: "application", configuration: { runtime: "firecracker" } } };
`,
  // Alchemy owns the Cloudflare control plane.
  "scripts/deploy/direct.ts": `
import { spawnSync } from "node:child_process";
export const list = () => fetch("https://api.cloudflare.com/client/v4/accounts/a/workers/scripts"); // expect: basalt/no-direct-cloudflare-api
export const deploy = () => spawnSync("npx", ["wrangler", "deploy"], { stdio: "inherit" }); // expect: basalt/no-direct-cloudflare-api
export const hosts = ["mcp.cloudflare.com", "api.cloudflare.com"];
`,
  // production: scripts/deploy-safety/release-runner.ts:346 at 1d75a5f1 (the deploy configuration check that
  // exited 1 with its output thrown away).
  "scripts/deploy/runner.ts": `
import { execFileSync, spawnSync } from "node:child_process";
export function validate(sourceRoot: string) {
  const validation = spawnSync(
    "node",
    ["--input-type=module", "-e", 'import { deployEnvironment } from "./scripts/environment.ts"; deployEnvironment();'],
    { cwd: sourceRoot, env: process.env, stdio: "ignore" }, // expect: basalt/no-discarded-child-output
  );
  const known = spawnSync("git", ["cat-file", "-e", "HEAD^{commit}"], { stdio: "ignore" }).status === 0;
  execFileSync("git", ["fetch", "--no-tags", "origin", "main"], { stdio: "ignore" }); // expect: basalt/no-discarded-child-output
  return validation.status === 0 && known;
}
`,
  // One-line rewrites that keep each bug must stay red.
  "scripts/evasions/requests.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
import { sameProvisioningValue as same } from "./provisioning-refusal.ts";
const W = Workers;
const { getScript } = Workers;
export const read = (target: { accountId: string; scriptName: string }, settings: { annotations: object }, versionId: string) => [
  Workers.getScriptVersion({ ...target, versionId } as Workers.GetScriptVersionRequest), // expect: basalt/no-direct-cloudflare-api, basalt/no-spread-into-provider-request
  W.getScript({ ...target }), // expect: basalt/no-direct-cloudflare-api, basalt/no-spread-into-provider-request
  getScript({ accountId: target.accountId, scriptName: target.scriptName, annotations: Object.assign({}, settings.annotations) }), // expect: basalt/no-direct-cloudflare-api, basalt/no-spread-into-provider-request
];
declare function digest(value: unknown): string;
declare function stableJson(value: unknown): string;
export const compare = async (provider: { read(): Promise<unknown> }, sent: unknown) => {
  const readBack = await provider.read();
  return [
    digest(sent) !== digest(readBack), // expect: basalt/no-exact-readback-compare
    stableJson(sent) === stableJson(readBack), // expect: basalt/no-exact-readback-compare
    same("application", sent, readBack), // expect: basalt/no-exact-readback-compare
    digest(sent) === "stored-digest",
  ];
};
`,
  "scripts/evasions/processes.ts": `
import { execSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import Cloudflare from "cloudflare";
const quiet = { stdio: "ignore" as const };
export const run = () => [
  spawnSync("node", ["check.ts"], { ...quiet }), // expect: basalt/no-discarded-child-output
  spawnSync("sh", ["-c", "deploy 2>/dev/null"]), // expect: basalt/no-discarded-child-output
  execSync("npx wrangler deploy"), // expect: basalt/no-direct-cloudflare-api
  createRequire(import.meta.url)("wrangler"), // expect: basalt/no-direct-cloudflare-api
  new Cloudflare(), // expect: basalt/no-direct-cloudflare-api
];
export const bun = (spawn: (command: string[], options: object) => void) => spawn(["deploy"], { stdout: "pipe", stderr: "ignore" }); // expect: basalt/no-discarded-child-output
`,
  "scripts/evasions/test/stand-in.ts": `
declare function readBody(request: unknown): Promise<string>;
const users: unknown[] = [];
const requests: unknown[] = [];
let latest: unknown;
export const handle = async (request: Request, user: object) => {
  const body = JSON.parse(await readBody(request));
  const payload = body;
  users.push(payload); // expect: basalt/no-echo-stub
  requests.push(body);
  const call = { rpc: "" };
  call.rpc = body.method;
  user.name = body.name; // expect: basalt/no-echo-stub
  Object.assign(user, body); // expect: basalt/no-echo-stub
  latest = structuredClone(body); // expect: basalt/no-echo-stub
  const { delay = 0 } = body;
  const forwarded = await fetch("https://upstream.test", { method: "POST", body: request.body });
  return [forwarded, delay, latest];
};
const settings = { id: "x" };
export const listed = () => Response.json({ success: true, errors: [], result: settings }); // expect: basalt/no-handwritten-provider-response
`,
  "scripts/evasions/extracted.ts": `
import * as Workers from "@distilled.cloud/cloudflare/workers";
export const put = (settings: { annotations: object }) => {
  const annotations = { ...settings.annotations, workersMessage: "marker" }; // expect: basalt/no-spread-into-provider-request
  return Workers.putScript({ accountId: "a", scriptName: "s", metadata: { annotations } }); // expect: basalt/no-direct-cloudflare-api
};
`,
  // landmines loads from the pinned configuration too.
  "src/pool/sleep.test.ts": `
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
test("waits", async () => {
  await setTimeout(100);
});
`,
  // An object made for one request may record a field of it; a store a later read serves may not,
  // whatever it is named.
  "scripts/evasions/test/records.ts": `
declare function readBody(request: Request): Promise<string>;
const calls: unknown[] = [];
const messages: Record<string, unknown> = {};
const catalog = { apps: [] as unknown[] };
const history = { latest: undefined as unknown };
const log = { policy: "" };
export const notion = async (request: Request) => {
  const call = { path: new URL(request.url).pathname, rpc: undefined as unknown };
  calls.push(call);
  const body = JSON.parse(await readBody(request));
  call.rpc = body.method;
  return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
};
export const stores = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  messages[body.id] = body; // expect: basalt/no-echo-stub
  catalog.apps = body.apps; // expect: basalt/no-echo-stub
  history.latest = body; // expect: basalt/no-echo-stub
  log.policy = body.policy; // expect: basalt/no-echo-stub
  return Response.json(history.latest);
};
export const sameRequest = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const reply = { policy: "" };
  reply.policy = body.policy; // expect: basalt/no-echo-stub
  return Response.json(reply);
};
export const nodeAnswer = async (request: Request, res: { json(value: unknown): void }) => {
  const body = JSON.parse(await readBody(request));
  const out = { name: "" };
  out.name = body.name; // expect: basalt/no-echo-stub
  res.json({ ok: true, out });
};
export const wholeBody = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const call = { body: undefined as unknown };
  call.body = body; // expect: basalt/no-echo-stub
  calls.push(call);
  return new Response("ok");
};
`,
  // A per-request record may only be written, asserted on and pushed onto a list nothing
  // answers with; any other way out of the handler is an echo.
  "scripts/evasions/test/escapes.ts": `
import type { IncomingMessage, ServerResponse } from "node:http";
declare function readBody(request: Request): Promise<string>;
const users: unknown[] = [];
const calls: unknown[] = [];
let latest: unknown;
export const alias = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const reply = { policy: "" };
  reply.policy = body.policy; // expect: basalt/no-echo-stub
  const out = reply;
  return Response.json(out);
};
export const postUser = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  users.push(user);
  return new Response("ok");
};
export const listUsers = (_request: Request) => Response.json(users);
export const putLatest = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const record = { value: "" };
  record.value = body.value; // expect: basalt/no-echo-stub
  latest = record;
  return new Response(String(latest !== undefined));
};
export const express = async (request: Request, res: { status(code: number): { json(value: unknown): void } }) => {
  const body = JSON.parse(await readBody(request));
  const out = { name: "" };
  out.name = body.name; // expect: basalt/no-echo-stub
  res.status(200).json(out);
};
export const hono = async (c: { req: { json(): Promise<{ name: string }> }; json(value: unknown): Response }) => {
  const body = await c.req.json();
  const out = { name: "" };
  out.name = body.name; // expect: basalt/no-echo-stub
  return c.json(out);
};
export const nodeRecorder = (request: IncomingMessage, res: ServerResponse) => {
  const call = { path: request.url, rpc: undefined as unknown };
  calls.push(call);
  let raw = "";
  request.on("data", (chunk) => (raw += chunk));
  request.on("end", () => {
    const body = JSON.parse(raw);
    call.rpc = body.method;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} }));
  });
};
export const nested = async (request: Request) => {
  const call = { rpc: "" };
  calls.push(call);
  const body = JSON.parse(await readBody(request));
  await Promise.resolve().then(() => {
    call.rpc = body.method;
  });
  return new Response("ok");
};
`,
  // A list records were pushed onto is answered however a response reaches it.
  "scripts/evasions/test/stores.ts": `
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
declare function readBody(request: Request): Promise<string>;
const aliased: unknown[] = [];
const served = aliased;
export const postAliased = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  aliased.push(user);
  return new Response("ok");
};
export const listAliased = (_request: Request) => Response.json(served);
const stringified: unknown[] = [];
export const postStringified = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  stringified.push(user);
  const text = JSON.stringify(stringified);
  return new Response(text);
};
const looped: unknown[] = [];
export const postLooped = async (request: IncomingMessage, res: ServerResponse) => {
  const body = JSON.parse(await readBody(request as unknown as Request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  looped.push(user);
  for (const row of looped) res.write(JSON.stringify(row));
  res.end();
};
const chained: unknown[] = [];
export const postChained = async (request: Request, res: { status(code: number): { json(value: unknown): void } }) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  chained.push(user);
  res.status(200).json(chained);
};
const destructured: unknown[] = [];
export const postDestructured = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  destructured.push(user);
  const [first] = destructured;
  return Response.json(first);
};
const helped: unknown[] = [];
const send = (res: { json(value: unknown): void }, value: unknown) => res.json(value);
export const postHelped = async (request: Request, res: { json(value: unknown): void }) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  helped.push(user);
  send(res, helped);
};
const inAssertion: unknown[] = [];
export const answeredInAssertion = async (request: Request, res: { end(value: string): void }) => {
  const body = JSON.parse(await readBody(request));
  const call = { name: "" };
  call.name = body.name; // expect: basalt/no-echo-stub
  inAssertion.push(call);
  assert.ok(true, String(res.end(JSON.stringify(call))));
};
const set: unknown[] = [];
export const setter = async (request: Request, res: { end(value: string): void }) => {
  const body = JSON.parse(await readBody(request));
  const call = {
    set name(value: string) {
      res.end(value);
    },
  };
  call.name = body.name; // expect: basalt/no-echo-stub
  set.push(call);
};
const logged: unknown[] = [];
export const logs = async (request: Request) => {
  const call = { rpc: "" };
  logged.push(call);
  const body = JSON.parse(await readBody(request));
  call.rpc = body.method;
  process.stdout.write(JSON.stringify(logged));
  return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
};
let reset: { rpc?: string }[] = [];
const summary: Record<string, unknown> = {};
export const resets = async (request: Request) => {
  const call: { rpc?: string } = {};
  reset.push(call);
  const body = JSON.parse(await readBody(request));
  call.rpc = body.method;
  return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
};
export const run = () => {
  reset = [];
  summary.first = reset.map((recorded) => recorded.rpc);
};
`,
  // A list is answered through a function a served value holds, a member, or a callback too.
  "scripts/evasions/test/closures.ts": `
import assert from "node:assert/strict";
declare function readBody(request: Request): Promise<string>;
const fixture = { ok: true };
const fetched: unknown[] = [];
export const fetchDouble = async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  fetched.push(user);
  return { ok: true, status: 200, json: async () => fetched };
};
const made: unknown[] = [];
const makeList = () => () => made;
const list = makeList();
export const postMade = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  made.push(user);
  return new Response("ok");
};
export const listMade = (_request: Request) => Response.json(list());
const gotten: unknown[] = [];
const db = {
  get users() {
    return gotten;
  },
};
export const postGotten = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  gotten.push(user);
  return Response.json(db.users);
};
const state = { users: [] as unknown[] };
const members = state.users;
export const postMember = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  members.push(user);
  return new Response("ok");
};
export const listMember = (_request: Request) => Response.json(state.users);
const written: unknown[] = [];
const holder: Record<string, unknown> = {};
holder.users = written;
export const postWritten = async (request: Request) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  written.push(user);
  return new Response("ok");
};
export const listWritten = (_request: Request) => Response.json(holder);
const each: unknown[] = [];
export const postEach = async (request: Request, res: { write(value: string): void; end(): void }) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  each.push(user);
  each.forEach((row) => res.write(JSON.stringify(row)));
  res.end();
};
const then: unknown[] = [];
export const postThen = async (request: Request, res: { json(value: unknown): void }) => {
  const body = JSON.parse(await readBody(request));
  const user = { name: "" };
  user.name = body.name; // expect: basalt/no-echo-stub
  then.push(user);
  await Promise.resolve(then).then((value) => res.json(value));
};
const recorded: { rpc?: string }[] = [];
export const honestDouble = async (_url: string, init: { body: string }) => {
  const call: { rpc?: string } = {};
  recorded.push(call);
  const body = JSON.parse(init.body);
  call.rpc = body.method;
  return { ok: true, status: 200, json: async () => fixture };
};
const routed: { rpc?: string }[] = [];
const route = async (request: Request) => {
  const call: { rpc?: string } = {};
  routed.push(call);
  const body = JSON.parse(await readBody(request));
  call.rpc = body.method;
  return Response.json(fixture);
};
export const delegates = (request: Request) => route(request);
export const checks = async () => {
  const response = await delegates(new Request("https://example.invalid"));
  assert.ok(response, String(routed.length));
  routed.forEach((call) => assert.equal(call.rpc, "x"));
};
`,
  "src/pool/aliased.test.ts": `
import { mock as m, test } from "node:test";
test("aliased", (t) => {
  m.method(globalThis, "fetch", async () => new Response("{}")); // expect: basalt/no-node-test-doubles
  t.before(() => {}, { timeout: 1_000 }); // expect: basalt/no-node-test-flake-masking
});
`,
  // node:test forms of landmines' no-test-doubles and no-flake-masking.
  "src/pool/doubles.test.ts": `
import { before, mock, test } from "node:test";
test("doubles", { skip: !process.env.TOOL }, async (t) => { // expect: basalt/no-node-test-flake-masking
  t.mock.method(globalThis, "fetch", async () => new Response("{}")); // expect: basalt/no-node-test-doubles
  t.mock.method(Date, "now", () => 1);
  t.mock.method(console, "info", () => {});
  const observed = mock.fn();
  const replaced = mock.fn(() => 1); // expect: basalt/no-node-test-doubles
  await t.test("inner", { timeout: 5_000 }, () => {}); // expect: basalt/no-node-test-flake-masking
  return [observed, replaced];
});
before(() => {}, { timeout: 1_000 }); // expect: basalt/no-node-test-flake-masking
test.skip("later", () => {}); // expect: basalt/no-node-test-flake-masking
test("runs", { skip: false }, () => {});
`,
} satisfies Record<string, string>;

// The vendored anti-slop rules and the built-in rule they pair with, as configured. Every
// enabled rule has a case, so a vendored rule edited to report nothing fails here.
const antiSlopCases = {
  "src/pool/effect-style.ts": `
import { Data, Effect } from "effect";
import { makeLedger } from "./ledger.ts"; // expect: anti-slop-effect/no-service-constructor-imports
class Missing extends Data.TaggedError("Missing")<{ readonly id: string }> {}
export const ledger = makeLedger;
export const failed = { _tag: "Missing", id: "a" }; // expect: anti-slop-effect/no-manual-tagged-construction
export const isMissing = (error: Missing) => error._tag === "Missing"; // expect: anti-slop-effect/no-manual-tag-comparison
export const recover = (program: Effect.Effect<number, Missing>) =>
  program.pipe(Effect.catch((error) => (error._tag === "Missing" ? Effect.succeed(0) : Effect.fail(error)))); // expect: anti-slop-effect/no-manual-effect-error-tag
export const rank = (state: "a" | "b" | "c") => (state === "a" ? 1 : state === "b" ? 2 : 3); // expect: anti-slop-effect/prefer-effect-match
export const tagged = (program: Effect.Effect<number, Missing>) =>
  program.pipe(Effect.catchTag("Missing", () => Effect.succeed(0)));
`,
  "src/pool/generic-style.ts": `
export const passThrough = (value: unknown) => value; // expect: anti-slop/no-unknown-parameters
export const isCount = (value: { a: string | number }) => typeof value.a === "number"; // expect: anti-slop/no-runtime-typeof
export const isText = (value: string | number): value is string => typeof value === "string";
// SAFETY: a justified assertion passes; a chain fabricating a type still fails.
export const cast = (value: string) => value as unknown as number; // expect: anti-slop/no-chained-type-assertions
export const narrowed = (value: string | number) => value as string; // expect: anti-slop/require-safety-comment-for-type-assertion
export const body = (id?: string) => ({ ...(id ? { id } : {}) }); // expect: anti-slop/no-conditional-empty-object-spread
export const flat = (items: string[][]) => items.reduce<string[]>((all, item) => [...all, ...item], []); // expect: oxc/no-accumulating-spread
export const loose: Record<string, unknown> = {}; // expect: anti-slop/no-unsafe-dictionary-type
`,
  "src/pool/more-style.ts": `
export const visible = (items: string[]) => items.filter((item) => item !== "").map((item) => item.trim()); // expect: anti-slop/no-array-filter-map
export const merged = (items: string[]) => items.reduce<Record<string, boolean>>((all, item) => Object.assign({}, all, { [item]: true }), {}); // expect: anti-slop/no-reduce-accumulator-copy
export const read = (target: object, key: string) => Reflect.get(target, key); // expect: anti-slop/no-object-parameters, anti-slop/no-reflect-get
export const call = (fn: (value: string) => string, value: string) => Reflect.apply(fn, undefined, [value]); // expect: anti-slop/no-reflect-apply
export const responseShape = { id: "a" }; // expect: anti-slop/no-shape-in-symbol-names
export function parsed(text: string): unknown { return JSON.parse(text); } // expect: anti-slop/no-unknown-returns
export type Opaque = unknown; // expect: anti-slop/no-unknown-type-aliases
export const widened = () => {
  const value: unknown = "a"; // expect: anti-slop/no-known-value-widening
  // SAFETY: assigned a string literal above.
  return value as string; // expect: anti-slop/no-widen-then-assert
};
`,
  "src/pool/module-mocking.test.ts": `
import { vi } from "vitest";
vi.mock("./ledger.ts"); // expect: anti-slop/no-module-mocking
`,
} satisfies Record<string, string>;
const suites = [
  { name: "basalt", cases, rules: /^basalt\//u },
  { name: "anti-slop", cases: antiSlopCases, rules: /^(?:anti-slop(?:-effect)?|oxc)\//u },
];

// A checkout directory named like a test path must not change which rules apply.
const scratch = mkdtempSync(join(tmpdir(), "owned-lint-"));
const root = join(scratch, "fix-pool-tests");
after(() => rmSync(scratch, { recursive: true, force: true }));
const sources = { ...cases, ...antiSlopCases };
for (const [file, source] of Object.entries(sources)) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), source.trimStart());
}
const all = lint(Object.keys(sources), { cwd: root });
const findings = all.filter(({ rule }) => rule.startsWith("basalt/"));

for (const suite of suites)
  for (const [file, source] of Object.entries(suite.cases))
    test(`${suite.name} rules on ${file}`, () => {
      const expected = source
        .trimStart()
        .split("\n")
        .flatMap((text, index) =>
          [...(text.match(/\/\/ expect: (.+)$/u)?.[1].split(", ") ?? [])].map(
            (rule) => `${index + 1} ${rule}`,
          ),
        )
        .sort();
      const actual = all
        .filter((finding) => finding.file === file && suite.rules.test(finding.rule))
        .map(({ line, rule }) => `${line} ${rule}`)
        .sort();
      assert.deepEqual(actual, expected);
    });

test("every basalt rule says what to do instead", () => {
  for (const finding of findings)
    assert.match(finding.message, /\. [A-Z][^.]*(?:\.|$)/u, finding.rule);
});

test("every enforced basalt, anti-slop and built-in rule has a case that shows it firing", () => {
  const config: Config = JSON.parse(
    readFileSync(new URL("./.oxlintrc.json", import.meta.url), "utf8"),
  );
  const fired = new Set(all.map(({ rule }) => rule));
  assert.deepEqual(
    Object.keys(config.rules).filter(
      (rule) =>
        severity(config.rules[rule]) === "error" &&
        !rule.startsWith("landmines-") &&
        !fired.has(rule),
    ),
    [],
  );
});

test("landmines rules load from the pinned configuration", () => {
  assert.ok(
    all.some(
      ({ rule, file }) =>
        rule === "landmines-testing/no-fixed-sleep" && file === "src/pool/sleep.test.ts",
    ),
  );
});
