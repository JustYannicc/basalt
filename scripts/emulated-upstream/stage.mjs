// What deploy, check, destroy and the hourly expiry decide, given the account, a clock and the
// stage's fetch. Raw provider output never reaches logs: only the release entry's own public lines
// and this stage's counts and names.
import { emulatedAccount } from "./cloudflare.mjs";
import { refusalPath } from "./mock-start.ts";
import { publicMessage, StageError } from "./public-error.mjs";
import { paths, requestBody, verdict } from "./shapes.mjs";
import { isMode, leaseHours, prefix, refusal as guardRefusal, stage, worker } from "./settings.ts";

/** A long stream is paced like a model, about 60 s; one that ends within 30 s came as a burst. */
export const LONG_MIN_MS = 30_000;
export const paced = (long, ms) => !long || ms >= LONG_MIN_MS;
const streamCount = Object.keys(paths).length * 2;

const counts = (resources) =>
  Object.fromEntries(Object.entries(resources).map(([kind, rows]) => [kind, rows.length]));
const status = (value) => (Number.isSafeInteger(value) ? value : undefined);
/** One side of the mock's own refusal, reduced to a status and whether aimock gave it. */
const refusalSide = (row) =>
  row && typeof row === "object"
    ? { status: status(row.status), aimock: row.aimock === true }
    : undefined;

/** Every reason a check fails; none means it passes. */
export function checkFailures({ worker401, refusal, streams }) {
  return [
    ...(worker401.length !== 2 || worker401.some((code) => code !== 401)
      ? ["the Worker answered a call without the key"]
      : []),
    ...([refusal.missing, refusal.wrong].some((row) => row?.status !== 401 || row.aimock !== true)
      ? ["the mock itself did not refuse a call without the right key"]
      : []),
    ...(streams.length !== streamCount ? [`${streams.length} of ${streamCount} streams ran`] : []),
    ...streams.filter((row) => !row.pass).map((row) => `${row.shape} ${row.kind} ${row.reason}`),
  ];
}

const errorKind = (error) => (/^[A-Za-z]{1,40}$/u.test(error?.name ?? "") ? error.name : "error");

export function emulatedStage({
  api,
  key,
  fetcher = fetch,
  now = Date.now,
  summary,
  save,
  deployEntry,
}) {
  /** The stage Worker's own host on the account's workers.dev subdomain. */
  async function origin() {
    const subdomain = await api.subdomain();
    if (!/^[a-z0-9-]{1,63}$/u.test(subdomain ?? ""))
      throw new StageError("The account has no workers.dev subdomain");
    return `${worker}.${subdomain}.workers.dev`;
  }
  // The scale stage declares the shared workers.dev host; calls here reach this stage by binding.
  const gateway = { fetch: (url, init) => fetcher(url, init) };

  /**
   * One call to the stage, read to its end. A failure names the call and the error's kind only:
   * a runtime's own error names the host, which carries the account's subdomain.
   */
  async function call(base, label, path, init, read) {
    try {
      const response = await gateway.fetch(`https://${base}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...init,
      });
      const body = read ? await read(response) : await response.body?.cancel();
      return { status: response.status, ok: response.ok, body };
    } catch (error) {
      throw new StageError(`The stage's ${label} call failed (${errorKind(error)})`);
    }
  }

  /** One streamed call, judged by the pinned load driver's rule for its shape. */
  async function stream(base, shape, long) {
    const kind = long ? "long" : "short";
    const started = now();
    let answer;
    try {
      answer = await call(
        base,
        `${shape} ${kind} stream`,
        paths[shape],
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            accept: "text/event-stream",
          },
          body: JSON.stringify(requestBody(shape, long)),
          signal: AbortSignal.timeout(180_000),
        },
        (response) => response.text(),
      );
    } catch (error) {
      return { shape, kind, pass: false, reason: publicMessage(error) };
    }
    const ms = now() - started;
    const judged =
      answer.status === 200 ? verdict(shape, long, answer.body) : { pass: false, reason: "status" };
    const pace = paced(long, ms);
    return {
      shape,
      kind,
      status: answer.status,
      ms,
      ...judged,
      pass: judged.pass && pace,
      reason: judged.reason ?? (pace ? undefined : "ended too soon"),
    };
  }

  async function check() {
    const deleteBy = await api.lease(worker);
    if (deleteBy === undefined)
      throw new StageError(
        `The emulated upstream is not deployed: Worker ${worker} or its DELETE_BY lease is missing; run deploy`,
      );
    if (deleteBy <= now())
      throw new StageError(
        `The emulated upstream's lease ended at ${new Date(deleteBy).toISOString()}; run destroy, or let the hourly expiry remove it`,
      );
    const base = await origin();
    // The Worker refuses these itself, before the container starts.
    const worker401 = [];
    for (const [label, headers] of [
      ["unkeyed", {}],
      ["wrong-key", { authorization: "Bearer wrong-key-of-the-right-length-000000" }],
    ])
      worker401.push((await call(base, label, "/v1/models", { headers })).status);
    const streams = await Promise.all(
      Object.keys(paths).flatMap((shape) => [
        stream(base, shape, false),
        stream(base, shape, true),
      ]),
    );
    // A keyed call has the mock itself answer without the key and with a wrong one.
    // A failed call counts as no refusal, so the streams' summary still reaches the log.
    const answer = await call(
      base,
      "mock refusal",
      refusalPath,
      { headers: { authorization: `Bearer ${key}` } },
      (response) => (response.ok ? response.json() : undefined),
    ).catch(() => ({}));
    const refusal = {
      status: answer.status,
      missing: refusalSide(answer.body?.missing),
      wrong: refusalSide(answer.body?.wrong),
    };
    save("check", { deleteBy: new Date(deleteBy).toISOString(), worker401, refusal, streams });
    for (const row of streams)
      summary(
        `- ${row.shape} ${row.kind}: HTTP ${row.status ?? "-"}, ${row.ms ?? "-"} ms, usage ${row.input ?? "-"} in / ${row.output ?? "-"} out, ${row.pass ? "passes" : `fails: ${row.reason}`}`,
      );
    summary(`- the Worker without the key / with a wrong key: HTTP ${worker401.join(", ")}`);
    summary(
      `- the mock itself without the key / with a wrong key: ${[refusal.missing, refusal.wrong].map((row) => (row ? `HTTP ${row.status}${row.aimock ? " (aimock)" : ""}` : `none (HTTP ${refusal.status ?? "-"})`)).join(", ")}`,
    );
    summary(`- lease ends ${new Date(deleteBy).toISOString()}`);
    const failed = checkFailures({ worker401, refusal, streams });
    if (failed.length) throw new StageError(`Emulated upstream check failed: ${failed.join("; ")}`);
  }

  async function destroy() {
    const { before, failures } = await api.destroy();
    save("teardown", { before: counts(before), failures: failures.length });
    summary(`- removed: ${api.describe(before) || "nothing was deployed"}`);
    summary(
      `- after teardown: no container application, Worker, Durable Object namespace or tagged image named ${prefix}-*`,
    );
    summary(
      "- not checked: a registry manifest pushed by digest alone, never tagged (the registry lists only tags)",
    );
  }

  /** Destroys the stage once its lease has passed, or when a run left it without one. */
  async function expire() {
    const found = await api.inventory();
    if (api.empty(found)) {
      summary(`- nothing named ${prefix}-* is deployed`);
      return "nothing";
    }
    const deleteBy = found.scripts.some((row) => row.id === worker)
      ? await api.lease(worker)
      : undefined;
    if (deleteBy !== undefined && deleteBy > now()) {
      summary(`- lease ends ${new Date(deleteBy).toISOString()}; nothing to do`);
      return "kept";
    }
    // Past its lease, without one, or a partial stage without its Worker: nothing will use it again.
    summary(
      `- ${deleteBy === undefined ? "no lease" : `lease ended ${new Date(deleteBy).toISOString()}`}; destroying`,
    );
    await destroy();
    return "destroyed";
  }

  async function deploy() {
    const existing = await api.inventory();
    if (!api.empty(existing))
      throw new StageError(
        `The emulated upstream stage already exists (${api.describe(existing)}); run destroy first`,
      );
    const deleteBy = now() + leaseHours * 60 * 60_000;
    // From here on a failed or cancelled run tears down what it may have created.
    save("deploy-started", { stage, deleteBy: new Date(deleteBy).toISOString() });
    deployEntry(deleteBy);
    await check();
  }

  return { deploy, check, destroy, expire };
}

/**
 * One run of the mode the environment names. Returns the exit code; prints only the guard's token
 * or this stage's own messages.
 */
export async function main(env, { fetcher = fetch, now = Date.now, error = console.error, ...io }) {
  const refused = guardRefusal(env, { credentialsLoaded: true });
  const mode = env.EMULATED_MODE ?? "";
  if (refused || !isMode(mode)) {
    error(refused ?? "emulated_upstream_mode_expected_deploy_check_destroy_or_expire");
    return 1;
  }
  try {
    const api = emulatedAccount({
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      token: env.CLOUDFLARE_API_TOKEN,
      prefix,
      fetcher,
    });
    await emulatedStage({ api, key: env.EMULATED_UPSTREAM_KEY, fetcher, now, ...io })[mode]();
    return 0;
  } catch (caught) {
    error(publicMessage(caught));
    return 1;
  }
}
