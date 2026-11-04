import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { cpus, totalmem, freemem } from "node:os";
import { execFileSync } from "node:child_process";

export class Resources {
  groups = new Map();
  owners = new Map();
  previous = new Map();
  suites = new Map();
  samples = [];
  last = performance.now();
  ticks = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  page = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim());
  interval;
  lastContainers = 0;
  containerSamples = 0;
  oomContainers = new Set();
  initialOomKills = this.oomKills();
  output;

  constructor(output) {
    this.output = output;
    this.interval = setInterval(() => this.sample(), 1_000);
    this.interval.unref();
  }

  register(suite, pid) { this.groups.set(pid, suite); }
  unregister(pid) { this.groups.delete(pid); }

  async stopSuite(suite) {
    const current = (pid, start) => {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        return fields[0] !== "Z" && fields[19] === start;
      } catch { return false; }
    };
    const owned = new Map();
    const capture = () => {
      this.sample();
      for (const [pid, item] of this.previous)
        if (this.owners.get(pid) === suite) owned.set(pid, item.start);
      return [...owned].filter(([pid, start]) => current(pid, start));
    };
    const signal = (processes, name) => {
      for (const [pid, start] of processes) {
        if (!current(pid, start)) continue;
        try { process.kill(pid, name); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    };
    // Descendants can outlive the shell and keep Motel files open. Start times prevent PID reuse.
    signal(capture(), "SIGTERM");
    for (const name of ["SIGTERM", "SIGKILL"]) {
      const deadline = Date.now() + 1_000;
      let live;
      while ((live = capture()).length && Date.now() < deadline) {
        signal(live, name);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!live.length) return;
    }
    throw new Error(`Owned processes still running after ${suite} stopped`);
  }

  oomKills() {
    return Number(/^oom_kill (\d+)$/m.exec(readFileSync("/proc/vmstat", "utf8"))?.[1] ?? 0);
  }

  containers(owners) {
    try {
      const ids = execFileSync("docker", ["ps", "--quiet", "--filter", "label=executor.e2e.role=cloud-postgres"],
        { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean);
      if (!ids.length) return;
      const format = '{"id":"{{.Id}}","pid":{{.State.Pid}},"owner":"{{index .Config.Labels "executor.e2e.pid"}}","oom":{{.State.OOMKilled}}}';
      const records = execFileSync("docker", ["inspect", "--format", format, ...ids],
        { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] });
      for (const line of records.trim().split("\n")) {
        const container = JSON.parse(line);
        const suite = owners.get(Number(container.owner));
        if (!suite) continue;
        if (container.pid) owners.set(container.pid, suite);
        if (container.oom) this.oomContainers.add(container.id);
        this.containerSamples++;
      }
    } catch { /* A disposable container can disappear before inspect. */ }
  }

  sample() {
    const now = performance.now();
    const seconds = (now - this.last) / 1_000;
    if (seconds <= 0) return;
    const processes = [];
    for (const id of readdirSync("/proc").filter((value) => /^\d+$/.test(value))) {
      try {
        const raw = readFileSync(`/proc/${id}/stat`, "utf8");
        const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
        processes.push({ pid: Number(id), parent: Number(fields[1]), group: Number(fields[2]),
          ticks: Number(fields[11]) + Number(fields[12]), start: fields[19], rss: Number(fields[21]) * this.page });
      } catch { /* A process can exit between enumeration and read. */ }
    }
    const owners = new Map(this.owners);
    const assign = () => { for (let pass = 0; pass < processes.length; pass++) {
      let added = false;
      for (const item of processes) {
        const owner = this.groups.get(item.group) ?? owners.get(item.parent);
        if (owner && !owners.has(item.pid)) { owners.set(item.pid, owner); added = true; }
      }
      if (!added) break;
    } };
    assign();
    if (now - this.lastContainers >= 5_000) {
      this.containers(owners);
      this.lastContainers = now;
      assign();
    }
    const sums = new Map();
    const next = new Map();
    for (const item of processes) {
      const owner = this.groups.get(item.group) ?? owners.get(item.pid);
      if (!owner) continue;
      const previous = this.previous.get(item.pid);
      const ticks = previous?.start === item.start ? Math.max(0, item.ticks - previous.ticks) : 0;
      const sum = sums.get(owner) ?? { rss: 0, cpu: 0 };
      sum.rss += item.rss;
      sum.cpu += ticks / this.ticks / seconds;
      sums.set(owner, sum);
      next.set(item.pid, item);
    }
    for (const [suite, sample] of sums) {
      const record = this.suites.get(suite) ?? { peakRssBytes: 0, peakCpuCores: 0, cpuCoreSeconds: 0, samples: 0 };
      record.peakRssBytes = Math.max(record.peakRssBytes, sample.rss);
      record.peakCpuCores = Math.max(record.peakCpuCores, sample.cpu);
      record.cpuCoreSeconds += sample.cpu * seconds;
      record.samples++;
      this.suites.set(suite, record);
    }
    this.samples.push({ seconds: now / 1_000, freeBytes: freemem(),
      rssBytes: [...sums.values()].reduce((sum, value) => sum + value.rss, 0),
      cpuCores: [...sums.values()].reduce((sum, value) => sum + value.cpu, 0) });
    if (this.output) appendFileSync(this.output, JSON.stringify({ ...this.samples.at(-1),
      kernelOomKills: this.oomKills() - this.initialOomKills,
      oomContainers: [...this.oomContainers], suites: Object.fromEntries(this.suites) }) + "\n");
    this.previous = next;
    this.owners = new Map([...owners].filter(([pid]) => next.has(pid)));
    this.last = now;
  }

  close() { clearInterval(this.interval); this.sample(); }

  report() {
    return { cpuCount: cpus().length, totalBytes: totalmem(), sampleIntervalMs: 1_000,
      measurement: "Sampled sum of owned process-tree RSS and CPU ticks; RSS can double-count shared pages, short-lived processes can be missed.",
      containerSamples: this.containerSamples, oomContainers: [...this.oomContainers],
      kernelOomKills: this.oomKills() - this.initialOomKills,
      suites: Object.fromEntries(this.suites), samples: this.samples };
  }
}
