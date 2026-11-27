import { Effect } from "effect";

/** The organization's provisioning queue, as proofs read it before they measure and after they end. */
export const provisioningJobs = (database, organization) =>
  database.run({
    sql: `select id, kind, status, attempts, available_at, updated_at, now() as observed_at
      from hosted_provisioning where organization_id = $1 order by updated_at, id limit 200`,
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
export const provisioningSettled = (jobs, now = observedAt(jobs)) =>
  jobs.every((job) => !open(job) || deferred(job, now));
// The database's own clock, as read with the jobs, so a host clock that drifts moves no deferral.
const observedAt = (jobs) =>
  jobs.length > 0 && jobs[0].observed_at !== undefined
    ? new Date(jobs[0].observed_at).getTime()
    : Date.now();

/** The organization's rollouts still open: they run before a proof starts, never inside it. */
export const openRollouts = (jobs) => jobs.filter((job) => open(job) && rolloutJob(job));

/** Run the organization's waiting rollouts now: each is queued once per release, delayed. */
export const bringRolloutsForward = (database, organization) =>
  database.run({
    sql: `update hosted_provisioning set available_at = now()
      where organization_id = $1 and status = 'queued' and available_at > now()
        and (id like 'basalt-pool-bundle:%' or id like 'basalt-pool-token:%'
          or id like 'basalt-catalog-apps:%')`,
    params: [organization],
  });

/** Changes committed for the organization and not yet delivered to its live subscribers. */
export const changeOutboxEmpty = (database, organization) =>
  database
    .run({
      sql: `select count(*)::int as count from hosted_change_pending where scope = $1`,
      params: [`organization:${organization}`],
    })
    .pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0) === 0));

/**
 * Make a retry waiting out its backoff due now. On self-host the drainer then runs it; on Cloud this
 * only lets the dispatcher pick it up again, and the workflow's own retry delay still applies. A job
 * waiting for its first attempt keeps its own schedule.
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

// A catalog sweep reports every app that failed as one "storage" step failure; the app's own line
// names the error. Its record names the job only in the attempt's annotations, after the message.
const sweepMessage = "Catalog app update failed";
// The errors the sweep's steps can log: the catalog read, the app's source, build and deploy,
// and the record write with its app lookup. Any other value is published as `other`, so the
// evidence never carries more than an error class, whatever the line holds.
const sweepCauses = new Set([
  "AccountNotFound",
  "AccountSelectionInvalid",
  "AppNotDeployed",
  "AppNotFound",
  "BuildBusy",
  "BuildMemoryExceeded",
  "BuildUnanswered",
  "CatalogUnavailable",
  "SourceError",
  "SqlError",
  "StorageError",
  "VersionBuildFailed",
  "VersionNotFound",
]);
// A catalog entry's name, such as `executor`: never an app id, an organization or a URL.
const appKind = /^[a-z][a-z0-9-]{0,63}$/;

/**
 * The whole record a message line sits in: the line itself when it holds the record, else the
 * printed block from its `{` to its `}`. Workers print into one log at once, so the block is read
 * from the message's own Worker's lines; a line with no block of its own stands alone.
 */
const blockAt = (lines, index) => {
  const worker = workerName.exec(lines[index])?.[0] ?? "";
  const content = lines[index].slice(worker.length).trim();
  if (content.startsWith("{") && content.endsWith("}")) return lines[index];
  const own = (at) => (workerName.exec(lines[at])?.[0] ?? "") === worker;
  // Only the record's own braces are unindented; a nested object's sit inside it.
  const edge = (at, brace) => own(at) && lines[at].slice(worker.length).trimEnd() === brace;
  let start = index;
  // A record that closed above the line is not its block: the line then stands alone.
  while (start > 0 && index - start < 40 && !edge(start, "{") && !edge(start, "}")) start--;
  if (!edge(start, "{")) return lines[index];
  const record = [];
  for (let at = start; at < lines.length && at - start < 60; at++) {
    if (!own(at)) continue;
    record.push(lines[at]);
    if (at > index && edge(at, "}")) break;
  }
  return record.join("\n");
};

/** A sweep's per-app failure, reduced to the error class from a closed list and the app's kind. */
const sweepFailure = (record) => {
  const cause = field(record, "cause");
  const entry = field(record, "entry");
  return {
    message: sweepMessage,
    cause: cause !== undefined && sweepCauses.has(cause) ? cause : "other",
    ...(entry !== undefined && appKind.test(entry) ? { app: entry } : {}),
  };
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
    if (line.includes(sweepMessage)) {
      // The job comes from the attempt's annotations, printed after the message, so nothing the
      // message's fields hold can name another job; the class and kind come from those fields.
      const record = blockAt(lines, index);
      const at = record.lastIndexOf("annotations");
      const job = at < 0 ? undefined : field(record.slice(at), "job");
      if (job !== undefined && logged.has(job))
        logged.get(job).push(sweepFailure(record.slice(0, at)));
      return;
    }
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
