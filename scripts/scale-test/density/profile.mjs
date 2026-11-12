import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { operation } from "./clients.mjs";
import { readResourceSamples } from "./phase.mjs";
export async function prepareProfile(context, profile) {
  const {
    root,
    out,
    base,
    network,
    image,
    bin,
    management,
    ports,
    container,
    run,
    until,
    json,
    home,
    attempt,
    observers,
    save,
  } = context;
  const pool = container([
    "--name",
    base + "-" + profile.name,
    "--network",
    network,
    "--network-alias",
    "density-pool",
    "--cpus",
    String(profile.vcpu),
    "--memory",
    profile.memoryGiB + "g",
    "--memory-swap",
    profile.memoryGiB + "g",
    "--mount",
    `type=bind,source=${root}/observe.py,target=/fixture-observe.py,readonly`,
    "--env",
    "POOL_DATABASE_URL=postgresql://fixture_admin:fixture-only@density-db:5432/basalt_pool",
    "--env",
    "POOL_DATABASE_SCHEMA_OWNER=basalt_pool_owner",
    "--env",
    "POOL_MANAGEMENT_KEY=" + management,
    "--env",
    "POOL_MANAGEMENT_ALLOW_REMOTE=true",
    "--env",
    "POOL_APP_SIGNING_KEY=" + "ab".repeat(32),
    image,
  ]);
  await until(async () => {
    const r = await fetch(ports.ready + "/ready", {
      headers: { authorization: "Bearer " + management },
      signal: AbortSignal.timeout(5000),
    });
    await r.body?.cancel();
    return r.ok;
  });
  await home("/config", {
    access: { "api-keys": ["synthetic-density-model"] },
    "api-keys": {
      "openai-compatibility": [
        {
          name: "density-synthetic-only",
          "base-url": "http://density-upstream:8080/v1",
          keys: ["a", "b", "c", "d"].map((x) => ({
            "api-key": "synthetic-density-account-" + x,
          })),
          models: [{ name: "density-synthetic", alias: "density-synthetic" }],
        },
      ],
    },
  });
  await until(async () => {
    const x = await json(ports.node + "/v1/models", {
      headers: { authorization: "Bearer synthetic-density-model" },
    });
    return x.data?.some((x) => x.id === "density-synthetic");
  });
  const caps = await home("/capabilities");
  if (!caps.server_info.database_pool) throw Error("Required Home DB counters absent");
  save(profile.name + "-capabilities.json", caps);
  const limits = JSON.parse(
    run([
      "exec",
      "--user",
      "root",
      pool,
      "python3",
      "-c",
      "import pathlib,json; p=pathlib.Path('/sys/fs/cgroup'); print(json.dumps({k:(p/k).read_text().strip() for k in ['cpu.max','memory.max','memory.swap.max']}))",
    ]),
  );
  if (
    limits["cpu.max"] !== profile.vcpu * 100000 + " 100000" ||
    Number(limits["memory.max"]) !== profile.memoryGiB * 2 ** 30 ||
    limits["memory.swap.max"] !== "0"
  )
    throw Error("Actual cgroup profile mismatch");
  save(profile.name + "-limits.json", {
    profile,
    limits,
    inspect: JSON.parse(run(["inspect", pool]))[0].HostConfig,
  });
  const egress = JSON.parse(
    run([
      "exec",
      pool,
      "python3",
      "-c",
      "import socket,json; result={};\nfor host in ['1.1.1.1','8.8.8.8']:\n try:\n  s=socket.create_connection((host,443),timeout=2);s.close();result[host]='CONNECTED'\n except OSError as e:result[host]=type(e).__name__\nprint(json.dumps(result))",
    ]),
  );
  save(profile.name + "-egress-control.json", egress);
  if (Object.values(egress).includes("CONNECTED"))
    throw Error("Synthetic fixture egress boundary failed");
  const output = createWriteStream(join(out, profile.name + "-resources.ndjson"));
  const observer = spawn(bin, ["exec", "--user", "root", pool, "python3", "/fixture-observe.py"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  observer.stdout.pipe(output);
  observers.push(observer);
  const idleStart = Date.now();
  await delay(32000);
  const idle = readResourceSamples(join(out, profile.name + "-resources.ndjson")).filter(
    (x) => x.at >= idleStart && x.cpu,
  );
  const first = idle[0],
    lastIdle = idle.at(-1);
  save(profile.name + "-idle.json", {
    start: idleStart,
    end: Date.now(),
    samples: idle.length,
    cpuMeanCores:
      (lastIdle.cpu.usage_usec - first.cpu.usage_usec) /
      1e6 /
      (lastIdle.monotonic - first.monotonic),
    memoryBytes: Math.max(...idle.map((x) => x.memoryCurrent)),
  });
  await json(ports.mock + "/settings", {
    method: "POST",
    body: JSON.stringify({
      rate: 1,
      contentBytes: 512,
      durationMs: 2000,
      phase: profile.name + "-controls",
    }),
  });
  const controls = [];
  for (const protocol of ["messages", "responses", "websocket"])
    controls.push(
      await operation(
        ports.node,
        protocol,
        "density-op-control-" + attempt + "-" + profile.name + "-" + protocol,
        2000,
        512,
        1,
      ),
    );
  save(profile.name + "-controls.json", controls);
  if (controls.some((x) => !x.pass))
    throw Error("Protocol fixture control failed; density did not start");

  return { pool, observer, output, controls };
}
