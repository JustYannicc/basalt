import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AwsOutputTail, awsFailureSummary } from "./diagnostics.ts";

function atomicWrite(directory: string, name: string, text: string) {
  const temporary = join(directory, `${name}.tmp`);
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, join(directory, name));
}

export class AwsProgress {
  private directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  enter(phase: string, checks: number): void {
    const summary = awsFailureSummary({ phase, checks });
    const context = { phase: summary.phase, checks: summary.checks ?? 0 };
    atomicWrite(this.directory, "phase-context.json", JSON.stringify(context));
    process.stdout.write(
      `${JSON.stringify({ awsProofPhase: context.phase, checks: context.checks })}\n`,
    );
  }
}

export function captureAwsChild(
  child: ChildProcessByStdio<null, Readable, Readable>,
  directory: string,
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const tail = new AwsOutputTail();
    let outputError: unknown;
    const retain = () => {
      try {
        atomicWrite(directory, "child-output-tail.json", tail.text());
      } catch (error) {
        outputError = error;
      }
    };
    retain();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      tail.push("stdout", chunk);
      retain();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      tail.push("stderr", chunk);
      retain();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        tail.finish();
        retain();
        if (outputError) throw outputError;
        resolve({ code, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function awsChildFailure(
  directory: string,
  exit: { code: number | null; timedOut: boolean; stderr?: string },
) {
  const readContext = (name: string) => {
    try {
      const value: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      return value !== null && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const context = readContext("failure-context.json") ?? readContext("phase-context.json") ?? {};
  return awsFailureSummary({ ...context, ...exit });
}
