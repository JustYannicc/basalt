import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { poolTestTimesFile } from "./pool-test-shard.ts";

/**
 * Seconds per pool test file from GitHub job logs of the pool-runtime contracts legs. Each line
 * carries GitHub's timestamp; the progress reporter marks each test's start and completion with
 * its file. A leg runs its files one at a time, so a file's time is its first start to its last
 * completion.
 */
export function fileSeconds(logs: readonly string[]) {
  const spans = new Map<string, { start: number; end: number }>();
  for (const log of logs)
    for (const line of log.split("\n")) {
      const match = /^﻿?(\S+Z) .*?OWNED_TEST (\{.*\})\s*$/u.exec(line);
      if (!match) continue;
      const at = Date.parse(match[1]!);
      const { phase, file } = JSON.parse(match[2]!) as { phase: string; file?: string };
      if (!file?.startsWith("scripts/pool-tests/") || Number.isNaN(at)) continue;
      const span = spans.get(file) ?? { start: at, end: at };
      if (phase === "start") span.start = Math.min(span.start, at);
      span.end = Math.max(span.end, at);
      spans.set(file, span);
    }
  return Object.fromEntries(
    [...spans].map(([file, { start, end }]) => [file, Math.round((end - start) / 1000)]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const logs = process.argv.slice(2);
  if (!logs.length) throw new Error("Expected one or more pool-runtime contracts job logs");
  const measured = fileSeconds(logs.map((path) => readFileSync(path, "utf8")));
  if (!Object.keys(measured).length) throw new Error("No pool test progress lines in those logs");
  const path = fileURLToPath(new URL(`../../${poolTestTimesFile}`, import.meta.url));
  const times = JSON.parse(readFileSync(path, "utf8"));
  const seconds = { ...times.seconds, ...measured };
  times.seconds = Object.fromEntries(
    Object.keys(seconds)
      .sort()
      .map((file) => [file, seconds[file]]),
  );
  writeFileSync(path, JSON.stringify(times, null, 2) + "\n");
  process.stdout.write(`Recorded ${Object.keys(measured).length} files in ${poolTestTimesFile}\n`);
}
