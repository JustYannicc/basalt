/** The organization's provisioning queue, as proofs read it before they measure and after they end. */
export const provisioningJobs = (database, organization) =>
  database.run({
    sql: `select id, kind, status, attempts, available_at, updated_at from hosted_provisioning
      where organization_id = $1 order by updated_at, id limit 200`,
    params: [organization],
  });

const open = ({ status }) => status === "queued" || status === "running";
const ran = ({ status, attempts }) => attempts > 0 || (status !== "queued" && status !== "running");

/**
 * A deploy queues these for every organization, each delayed so the deploy can finish first: a pool
 * bundle reconcile, a pool token rotation and a catalog app sweep. Their attempts can commit the
 * organization's defaults like its own setup does.
 */
const rolloutPrefixes = ["basalt-pool-bundle:", "basalt-pool-token:", "basalt-catalog-apps:"];
export const rolloutJob = ({ id }) => rolloutPrefixes.some((prefix) => id.startsWith(prefix));

/** How far ahead a deferred rollout must be due to stay clear of a measurement that follows. */
export const measurementMarginMs = 60_000;
const deferred = (job, now) =>
  rolloutJob(job) &&
  job.status === "queued" &&
  new Date(job.available_at).getTime() > now + measurementMarginMs;

/**
 * Settled: every job of the organization has finished, except a deploy's rollout still queued for
 * well after the measurement. A running rollout, or one due soon, is waited for like setup.
 */
export const provisioningSettled = (jobs, now = Date.now()) =>
  jobs.every((job) => !open(job) || deferred(job, now));

/**
 * Bring forward a retry waiting out its backoff. A job waiting for its first attempt keeps its own
 * schedule: a rollout's delay gives the deploy time to finish.
 */
export const bringRetriesForward = (database, organization) =>
  database.run({
    sql: `update hosted_provisioning set available_at = now()
      where organization_id = $1 and status = 'queued' and attempts > 0 and available_at > now()`,
    params: [organization],
  });

/**
 * Jobs whose attempt can fall inside the measurement between two readings of the queue: one open at
 * the first that ran an attempt or finished by the second, one already in flight at the first, and
 * one that appears only at the second and has run. An attempt can commit the organization's
 * defaults even when its job keeps waiting, so a measurement taken across one is not valid.
 */
export const provisioningMoved = (first, second) => [
  ...first.filter(open).flatMap((job) => {
    const later = second.find(({ id }) => id === job.id);
    const inFlight = job.status === "running" && job.attempts > 0;
    const changed =
      later === undefined || later.attempts !== job.attempts || later.status !== job.status;
    return inFlight || changed ? [{ id: job.id, before: job, after: later ?? null }] : [];
  }),
  ...second
    .filter((job) => !first.some(({ id }) => id === job.id) && ran(job))
    .map((job) => ({ id: job.id, before: null, after: job })),
];

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
