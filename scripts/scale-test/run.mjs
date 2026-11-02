import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cf, list, inventory, assertAbsent, pg, publicInventory } from "./api.mjs";
import { stageClient, stageOrigin } from "./stage-client.mjs";
import { candidate, credentials, imageDigest, prefix, sizes, stage, validate, worker } from "./settings.ts";

validate();
if (process.env.SCALE_MODE === "validate") { console.log("Scale guards passed"); process.exit(); }
const output = process.env.SCALE_OUTPUT;
if (!output) throw new Error("Missing private output directory");
mkdirSync(output, { recursive: true, mode: 0o700 });
const save = (name, value) => writeFileSync(`${output}/${name}.json`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const secrets = credentials();
let origin;
let deadline;
let image;
const jobStarted = Number(process.env.SCALE_JOB_STARTED_AT);
if (process.env.SCALE_MODE === "run" && (!Number.isFinite(jobStarted) || jobStarted > Date.now())) throw new Error("Missing CI job start time");
const trafficEndsAt = () => Math.min(deadline - 20 * 60_000, jobStarted + 70 * 60_000);
class CapacityStop extends Error {}
let billedBytesUpper = 0;
const previousBytes = new Map();
function accountBytes(values) {
  for (const [name, current] of Object.entries(values)) {
    if (!Number.isFinite(current) || current < 0) throw new Error("Transfer counter is unavailable");
    const previous = previousBytes.get(name) ?? 0;
    billedBytesUpper += 4 * (current >= previous ? current - previous : current);
    previousBytes.set(name, current);
  }
  return billedBytesUpper;
}
function deploy(size) {
  const env = { ...process.env, ALCHEMY_STAGE: stage, SCALE_SIZE: size, SCALE_IMAGE: image,
    SCALE_ADMIN: secrets.admin, SCALE_MANAGEMENT: secrets.management, SCALE_SIGNING: secrets.signing,
    SCALE_SEED: secrets.seed, SCALE_DEADLINE: String(deadline), SCALE_ORIGIN: origin };
  const result = spawnSync("bun", ["run", "alchemy", "deploy", "../../../../../../scripts/scale-test/stack.ts", "--stage", stage, "--yes"], {
    cwd: ".local/scale-candidate/.upstream/apps/hosted/cloud", env, encoding: "utf8", timeout: 12 * 60_000, maxBuffer: 8 * 1024 * 1024,
  });
  // Provider failures can contain connection strings. Keep raw Alchemy output out of logs and artifacts.
  if (result.status !== 0) throw new Error("Scale Alchemy deploy failed; no provider output was published");
}
async function request(path, body, method = body === undefined ? "GET" : "POST") {
  if (Date.now() >= trafficEndsAt()) throw new Error("Traffic deadline reached");
  const response = await stageClient.fetch(origin, path, { method, headers: { "X-Scale-Admin": secrets.admin, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(Math.max(1, Math.min(210_000, trafficEndsAt() - Date.now()))) });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Synthetic control request failed (${response.status})`); }
  return response.status === 204 ? null : response.json();
}
async function settings() {
  const data = await cf(`workers/scripts/${worker}/settings`);
  if (!data) throw new Error("Deploy scale-180 first");
  const bindings = data.result.bindings;
  const value = (name) => bindings.find((row) => row.name === name)?.text;
  deadline = Number(value("TEST_DEADLINE")); origin = value("TEST_ORIGIN"); image = value("POOL_IMAGE_HASH");
  if (!Number.isFinite(deadline) || !image?.endsWith(imageDigest) || !/^https:\/\/basalt-180-scale-gateway\.[a-z0-9-]+\.workers\.dev$/.test(origin ?? ""))
    throw new Error("Deployed scale settings do not match the frozen target");
}
async function configure(size) {
  const started = Date.now();
  await request("/_test/pool/warm", {});
  save(`${size}-startup`, { elapsedMs: Date.now() - started, runtime: await request("/_test/pool/stats") });
  const isolation = await request("/_test/pool/isolation");
  save(`${size}-isolation`, isolation);
  if (isolation.exitCode !== 0 || isolation.checks?.[0]?.status !== 403 || isolation.checks?.[1]?.status !== 403 || isolation.checks?.[2]?.status !== 200)
    throw new Error("Synthetic egress isolation failed");
  const keys = Array.from({ length: 5000 }, (_, user) => `scale-${createHash("sha256").update(`${secrets.seed}:${user}`).digest("hex")}`);
  const config = {
    access: { "api-keys": keys },
    "api-keys": { "openai-compatibility": [{ name: "scale-mock", "base-url": "http://scale-mock.invalid/v1", keys: [{ "api-key": "synthetic-only" }],
      models: ["scale-chat", "scale-codex", "scale-claude"].map((name) => ({ name, alias: name })) }] },
  };
  await request("/_test/pool/home/config", config, "PATCH");
  save(`${size}-config`, { sha256: createHash("sha256").update(JSON.stringify(config)).digest("hex") });
}
async function job(spec) {
  await request("/_test/mock/settings", { duration: spec.streamSeconds, rate: spec.rate ?? 50 });
  const persistedBefore = await request("/_test/pool/db");
  await request("/_test/gen/start", spec);
  const samples = [];
  let hotCpuSamples = 0;
  // Poll only the synthetic experiment's completion and independent fixture health.
  for (;;) {
    const [result, pool, generator, mock] = await Promise.all([
      request(`/_test/gen/job/${spec.id}`), request("/_test/pool/stats"), request("/_test/gen/stats"), request("/_test/mock/stats"),
    ]);
    const billableBytesUpper = accountBytes({ request: generator.requestBytes, response: generator.responseBytes, mockIn: mock.bytesIn, mockOut: mock.bytesOut });
    const estimatedUpperUsd = 4.5 + billableBytesUpper / 1e9 * 0.06;
    const budget = { billableBytesUpper, estimatedUpperUsd, capUsd: 10, stopTrafficUsd: 7.5, fixedReserveUsd: 4.5, invoiceAvailable: false };
    samples.push({ at: Date.now(), pool, generator, mock, budget });
    save(spec.id, { spec, result, samples });
    if (billableBytesUpper > 50e9 || estimatedUpperUsd >= 7.5) throw new Error("Conservative transfer or spend stop reached");
    const memory = Number(pool.sample?.memoryCurrent); const maximum = Number(pool.sample?.memoryMax);
    if (!Number.isFinite(memory) || !Number.isFinite(maximum) || maximum <= 0) throw new Error("Pool memory limit is unavailable");
    if (memory / maximum >= 0.8) throw new CapacityStop("Pool reached the 80 percent memory stop; sample saved");
    const cpu = (sample) => Number(/usage_usec (\d+)/.exec(sample.cpuStat ?? "")?.[1]);
    if (samples.length > 1) {
      const before = samples.at(-2).pool.sample;
      const [quota, period] = (pool.sample.cpuMax ?? "").trim().split(/\s+/).map(Number);
      const seconds = pool.sample.time - before.time;
      if (Number.isFinite(quota) && period > 0 && seconds > 0) {
        const fraction = (cpu(pool.sample) - cpu(before)) / 1e6 / seconds / (quota / period);
        hotCpuSamples = fraction >= 0.8 ? hotCpuSamples + 1 : 0;
        if (hotCpuSamples >= 2) throw new CapacityStop("Pool sustained the 80 percent CPU stop; samples saved");
      }
    }
    if (samples.length > 1) {
      const before = samples.at(-2); const seconds = (Date.now() - before.at) / 1000;
      if (seconds > 0 && ((generator.cpuSeconds - before.generator.cpuSeconds) / seconds >= 0.8
        || (mock.cpuSeconds - before.mock.cpuSeconds) / seconds >= 0.8))
        throw new Error("A synthetic fixture event loop is saturated; pool capacity is unmeasured");
    }
    if (result.state === "done") {
      if (result.success !== result.count) throw new CapacityStop(`First synthetic failure at ${spec.id}; evidence saved`);
      if (result.scheduleLagMsP99 > 1000) throw new Error("Generator is saturated; pool capacity is unmeasured");
      const expected = persistedBefore.usage[0].records + result.count;
      const settleBy = Date.now() + 30_000;
      for (;;) {
        const persisted = await request("/_test/pool/db");
        save(`${spec.id}-persistence`, { expected, before: persistedBefore, after: persisted });
        if (persisted.usage[0].records >= expected) break;
        if (Date.now() >= settleBy) throw new Error("Completed usage did not become durable within 30 seconds");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
async function resize(size) {
  if (!sizes.includes(size)) throw new Error("Unsupported test instance size");
  const app = (await inventory()).applications.find((row) => row.name === `${prefix}-pool`);
  if (!app?.configuration?.image?.endsWith(imageDigest)) throw new Error("Isolated pool image differs from the frozen target");
  if (app.configuration.instance_type === size) return;
  const configuration = { ...app.configuration, instance_type: size };
  await cf(`containers/applications/${app.id}`, "PATCH", { max_instances: 1, configuration });
  // Use the same immediate rollout as the pinned Alchemy container provider.
  await cf(`containers/applications/${app.id}/rollouts`, "POST", {
    strategy: "rolling", kind: "full_auto", step_percentage: 100, target_configuration: configuration,
  });
  const observed = await cf(`containers/applications/${app.id}`);
  if (observed?.result?.configuration?.instance_type !== size) throw new Error("Test instance size readback differs");
}
async function destroy() {
  process.env.SCALE_CONTROL_END_AT = String(Math.min(Date.now() + 15 * 60_000,
    Number.isFinite(jobStarted) ? jobStarted + 90 * 60_000 : Infinity));
  const before = await inventory(); save("teardown-before", publicInventory(before));
  if (Object.values(before).every((rows) => rows.length === 0)) {
    save("teardown", { at: new Date().toISOString(), resources: publicInventory(before), alreadyAbsent: true }); return;
  }
  const expectedDeadline = process.env.SCALE_EXPECT_DEADLINE;
  if (expectedDeadline) {
    const settings = await cf(`workers/scripts/${worker}/settings`);
    const observed = settings?.result?.bindings?.find((row) => row.name === "TEST_DEADLINE")?.text;
    if (observed && observed !== expectedDeadline) {
      save("expiry-skipped", { reason: "A different lease owns the stage" }); return;
    }
  }
  // Missing Workers do not prevent reclaiming the remaining issue-scoped resources.
  const cleanupErrors = [];
  const remove = async (kind, operation) => { try { await operation(); } catch { cleanupErrors.push(kind); } };
  for (const app of before.applications) await remove("container", () => cf(`containers/applications/${app.id}`, "DELETE"));
  for (const script of before.scripts) await remove("worker", () => cf(`workers/scripts/${script.id}?force=true`, "DELETE"));
  for (const drive of before.drives) await remove("hyperdrive", () => cf(`hyperdrive/configs/${drive.id}`, "DELETE"));
  for (const certificate of before.certificates) await remove("certificate", () => cf(`mtls_certificates/${certificate.id}`, "DELETE"));
  for (const namespace of before.kv) await remove("kv", () => cf(`storage/kv/namespaces/${namespace.id}`, "DELETE"));
  if (before.database.length) await remove("database", () => pg("DELETE"));
  const after = await inventory(); save("teardown", { at: new Date().toISOString(), cleanupErrors, resources: publicInventory(after) });
  assertAbsent(after);
}
try {
  if (process.env.SCALE_MODE === "destroy") await destroy();
  else if (process.env.SCALE_MODE === "deploy") {
    assertAbsent(await inventory());
    const applications = await list("containers/applications");
    const matches = applications.map((row) => row.configuration?.image).filter((value) => value?.endsWith(imageDigest));
    const repository = applications.map((row) => row.configuration?.image).find((value) => value?.includes("/basalt-poolcontainer-production-"));
    image = matches[0] ?? (repository ? `${repository.split("@")[0].replace(/:[^/]+$/, "")}@${imageDigest}` : undefined);
    if (!image) throw new Error("Frozen pool image repository is unavailable in this Cloudflare account");
    const subdomain = (await cf("workers/subdomain"))?.result?.subdomain;
    origin = stageOrigin(subdomain); deadline = Date.now() + 2 * 60 * 60_000;
    save("lease", { candidate, imageDigest, stage, firstCreateNotBefore: new Date().toISOString(), deleteBy: new Date(deadline).toISOString(), capUsd: 10, priorEstimateUpperUsd: 0.20 });
    deploy("lite");
    await settings();
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deadline=${deadline}\n`);
  } else {
    await settings();
    process.env.SCALE_CONTROL_END_AT = String(trafficEndsAt());
    save("candidate", { candidate, imageDigest, deleteBy: new Date(deadline).toISOString(), usersAreDistinctFromConcurrentStreams: true,
      fixtureSha256: Object.fromEntries(["mock", "generator", "sampler"].map((name) => [name, createHash("sha256").update(readFileSync(`scripts/scale-test/${name}.py`)).digest("hex")])) });
    for (const size of sizes) {
      if (trafficEndsAt() - Date.now() < 20 * 60_000) {
        save("size-budget-stop", { unmeasuredSizes: sizes.slice(sizes.indexOf(size)), remainingMs: Math.max(0, trafficEndsAt() - Date.now()) });
        break;
      }
      try {
        await resize(size);
        save(`${size}-deployment`, publicInventory(await inventory()));
        await request("/_test/pool/stop", {});
        await configure(size);
        for (const protocol of ["chat", "responses", "messages"]) await job({ id: `${size}-${protocol}-probe`, protocol, users: 1, concurrency: 1, requests: 1, streamSeconds: 2, bodyBytes: 1024 });
        for (const [users, concurrency] of [[1, 20], [200, 800], [200, 2000], [200, 4000], [5000, 5000]])
          await job({ id: `${size}-${users}-${concurrency}`, users, concurrency, requests: concurrency, streamSeconds: 60, bodyBytes: 262144, startsPerSecond: 100 });
        await job({ id: `${size}-long`, users: 20, concurrency: 20, requests: 20, streamSeconds: 360, bodyBytes: 262144, rate: 1 });
        const beforeRestart = await request("/_test/pool/db");
        await request("/_test/pool/stop", {}); await request("/_test/pool/warm", {});
        const afterRestart = await request("/_test/pool/db");
        save(`${size}-restart`, { beforeRestart, afterRestart });
        if (afterRestart.usage[0].records !== beforeRestart.usage[0].records) throw new Error("Restart changed durable usage count");
        const idleAt = Date.now(); await new Promise((resolve) => setTimeout(resolve, 65_000));
        await request("/_test/pool/warm", {});
        save(`${size}-idle`, { idleSeconds: (Date.now() - idleAt) / 1000, sample: await request("/_test/pool/stats") });
      } catch (error) {
        if (!(error instanceof CapacityStop)) throw error;
        save(`${size}-capacity-stop`, { message: error.message, at: new Date().toISOString() });
        await request("/_test/gen/stop", {});
      }
    }
  }
} catch (error) {
  // Errors from the synthetic controller are bounded strings; no remote bodies are included.
  save("failure", { at: new Date().toISOString(), message: error.message });
  throw error;
}
