/** The organization's provisioning queue, as proofs read it before they measure and after they end. */
export const provisioningJobs = (database, organization) =>
  database.run({
    sql: `select id, kind, status, attempts, available_at, updated_at from hosted_provisioning
      where organization_id = $1 order by updated_at, id limit 200`,
    params: [organization],
  });

/** Settled: none of the organization's jobs waits to run or is running. */
export const provisioningSettled = (jobs) =>
  jobs.every(({ status }) => status !== "queued" && status !== "running");

// The queue keeps no error. The runner logs one line for each attempt that failed or must wait.
const attemptMessages = [
  "Provisioning step failed",
  "Provisioning attempt failed",
  "Pool setup is waiting for the deploy to finish",
  "Member setup is waiting for team installation",
];
const field = (text, key) =>
  new RegExp(`["']?\\b${key}\\b["']?\\s*[:=]\\s*["']([^"'\\n]+)["']`).exec(text)?.[1];

const workerName = /^\[[^\]\s]+\] /;
/** The record a message line belongs to: that line, or the printed block it opens, to its `}`. */
const recordAt = (lines, index) => {
  if (field(lines[index], "job") !== undefined) return lines[index];
  const record = [lines[index]];
  for (let at = index + 1; at < lines.length && record.length < 8; at++) {
    const content = lines[at].replace(workerName, "");
    // A block ends at its closing brace; an unindented line starts another record.
    if (content.trim() === "}" || /^\S/.test(content)) break;
    record.push(lines[at]);
  }
  return record.join("\n");
};

/**
 * Each job with the attempts the hosted log recorded for it: the line's message and, where it has
 * one, its reason. A record may be printed over several lines, so its fields are read from the
 * lines of its own block.
 */
export const provisioningHistory = (jobs, log) => {
  const lines = log.split("\n");
  const logged = new Map(jobs.map((job) => [job.id, []]));
  lines.forEach((line, index) => {
    const message = attemptMessages.find((name) => line.includes(name));
    if (message === undefined) return;
    const record = recordAt(lines, index);
    const job = field(record, "job");
    if (job === undefined || !logged.has(job)) return;
    const reason = field(record, "reason");
    logged.get(job).push({ message, ...(reason === undefined ? {} : { reason }) });
  });
  return jobs.map((job) => ({ ...job, logged: logged.get(job.id) }));
};
