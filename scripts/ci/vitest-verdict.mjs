import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const errorRecord = (error) => Object.fromEntries(
  ["name", "message", "stack", "diff", "actual", "expected"].map((key) => [key, error[key] ?? null]),
);

// Vitest's JSON reporter omits unhandled errors and assertion diffs. Neither may be inferred away.
export default class CiVerdict {
  constructor({ outputFile }) { this.outputFile = outputFile; }

  onInit(context) {
    this.shutdown = { complete: false, error: false, timedOut: false, uncaught: false, exitCode: null };
    let closing = false;
    const close = context.close.bind(context);
    context.close = async (...args) => {
      closing = true;
      try { const result = await close(...args); this.shutdown.complete = true; return result; }
      catch (error) { this.shutdown.error = true; this.save(); throw error; }
    };
    const logError = context.logger.error.bind(context.logger);
    context.logger.error = (...args) => {
      if (closing) { this.shutdown.error = true; this.save(); }
      return logError(...args);
    };
    process.on("uncaughtExceptionMonitor", () => { this.shutdown.uncaught = true; this.save(); });
    process.on("exit", (code) => { this.shutdown.exitCode = code; this.save(); });
  }

  onProcessTimeout() { this.shutdown.timedOut = true; this.save(); }

  save() {
    if (!this.report) return;
    mkdirSync(dirname(this.outputFile), { recursive: true });
    writeFileSync(this.outputFile, JSON.stringify({ ...this.report, shutdown: this.shutdown }, null, 2));
  }

  onTestRunEnd(modules, unhandledErrors, reason) {
    const report = dirname(dirname(this.outputFile));
    const evidence = join(report, "evidence");
    const primary = existsSync(evidence) ? readdirSync(evidence).map((id) =>
      JSON.parse(readFileSync(join(evidence, id, "result.json"), "utf8"))) : [];
    const tests = modules.flatMap((module) => [...module.children.allTests()].map((test) => ({
      id: test.id,
      file: basename(module.moduleId),
      title: test.name,
      state: test.result().state,
      errors: (test.result().errors ?? []).map(errorRecord),
      primary: primary.find((entry) => entry.file === basename(module.moduleId) && entry.title === test.name) ?? null,
    })));
    const suiteErrors = modules.flatMap((module) => [module, ...module.children.allSuites()]
      .flatMap((suite) => suite.errors().map(errorRecord)));
    this.report = {
      version: 1, reason, unhandledErrors: unhandledErrors.map(errorRecord), suiteErrors, tests,
    };
    this.save();
  }
}
