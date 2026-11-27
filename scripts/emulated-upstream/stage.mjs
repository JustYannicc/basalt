// What deploy, check, destroy and the hourly expiry decide, given the account, a clock and the
// stage's fetch. Raw provider output never reaches logs: only the release entry's own public lines
// and this stage's counts and names.
import { emulatedAccount } from "./cloudflare.mjs";
import { plainReason, profileControlPath } from "./gateway.ts";
import { refusalPath } from "./mock-start.ts";
import { profileCheck, profileFailures, profileSummary } from "./profile-check.mjs";
import { isCloudflareApiError } from "../stage-cloudflare/api.mjs";
import { publicMessage, StageError } from "./public-error.mjs";
import { paths, requestBody, verdict } from "./shapes.mjs";
import { isMode, leaseHours, prefix, refusal as guardRefusal, stage, worker } from "./settings.ts";

/** A long stream is paced like a model, about 60 s; one that ends within 30 s came as a burst. */
export const LONG_MIN_MS = 30_000;
const shortest = (long) => (long ? LONG_MIN_MS : 0);
export const paced = (long, ms) => ms >= shortest(long);
/** How long a deploy waits for the platform to start the mock, and how often it asks. */
export const mockWaitBoundMs = 120_000;
export const mockWaitPauseMs = 5_000;
const streamCount = Object.keys(paths).length * 2;
const wholeCount = Object.keys(paths).length;
/** Every route the Worker refuses without the right key, profile b's control included. */
export const keyedRoutes = ["/v1/models", "/a/v1/models", "/b/v1/models", profileControlPath];
const refusedCount = keyedRoutes.length * 2;

const counts = (resources) =>
  Object.fromEntries(Object.entries(resources).map(([kind, rows]) => [kind, rows.length]));
const status = (value) => (Number.isSafeInteger(value) ? value : undefined);
/** One side of the mock's own refusal, reduced to a status and whether aimock gave it. */
const refusalSide = (row) =>
  row && typeof row === "object"
    ? { status: status(row.status), aimock: row.aimock === true }
    : undefined;

/** Every reason a check fails; none means it passes. */
export function checkFailures({ worker401, refusal, streams, wholes = [], profiles }) {
  const failed = (rows) => rows.filter((row) => !row.pass);
  return [
    ...(worker401.length !== refusedCount
      ? [`${worker401.length} of ${refusedCount} calls without the right key ran`]
      : []),
    ...worker401
      .filter((row) => row.status !== 401)
      .map((row) => `the Worker answered ${row.call} with HTTP ${row.status}`),
    ...([refusal.missing, refusal.wrong].some((row) => row?.status !== 401 || row.aimock !== true)
      ? ["the mock itself did not refuse a call without the right key"]
      : []),
    ...(streams.length !== streamCount ? [`${streams.length} of ${streamCount} streams ran`] : []),
    ...failed(streams).map((row) => `${row.shape} ${row.kind} ${row.reason}`),
    ...(wholes.length !== wholeCount
      ? [`${wholes.length} of ${wholeCount} non-streamed calls ran`]
      : []),
    ...failed(wholes).map((row) => `${row.shape} ${row.kind} ${row.reason}`),
    ...profileFailures(profiles),
  ];
}

const errorKind = (error) => (/^[A-Za-z]{1,40}$/u.test(error?.name ?? "") ? error.name : "error");

export function emulatedStage({
  api,
  key,
  fetcher = fetch,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

  /**
   * One model call, judged by the pinned load driver's rule for its shape: streamed unless
   * `stream` is false, through a profile's prefix when `via` names one, and no sooner than
   * `atLeastMs`, nor later than `atMostMs` when given.
   */
  async function model(
    base,
    shape,
    {
      kind,
      long = false,
      stream = true,
      via = "",
      atLeastMs = 0,
      atMostMs = Infinity,
      early = "ended too soon",
      late = "took longer than its bound",
    },
  ) {
    const started = now();
    let answer;
    try {
      answer = await call(
        base,
        stream ? `${shape} ${kind} stream` : `${shape} ${kind}`,
        `${via}${paths[shape]}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            accept: stream ? "text/event-stream" : "application/json",
          },
          body: JSON.stringify(requestBody(shape, long, { stream })),
          signal: AbortSignal.timeout(180_000),
        },
        (response) => response.text(),
      );
    } catch (error) {
      return { shape, kind, pass: false, reason: publicMessage(error) };
    }
    const ms = now() - started;
    const judged =
      answer.status === 200
        ? verdict(shape, long, answer.body, { stream })
        : { pass: false, reason: "status" };
    const pace = ms < atLeastMs ? early : ms > atMostMs ? late : undefined;
    return {
      shape,
      kind,
      status: answer.status,
      ms,
      ...judged,
      pass: judged.pass && pace === undefined,
      reason: judged.reason ?? pace,
    };
  }

  const streamed = (base, shape, long) =>
    model(base, shape, { kind: long ? "long" : "short", long, atLeastMs: shortest(long) });

  async function leased() {
    const deleteBy = await api.lease(worker);
    if (deleteBy === undefined)
      throw new StageError(
        `The emulated upstream is not deployed: Worker ${worker} or its DELETE_BY lease is missing; run deploy`,
      );
    if (deleteBy <= now())
      throw new StageError(
        `The emulated upstream's lease ended at ${new Date(deleteBy).toISOString()}; run destroy, or let the hourly expiry remove it`,
      );
    return deleteBy;
  }

  async function check() {
    const deleteBy = await leased();
    const base = await origin();
    // The Worker refuses these itself, before the container starts. Profile b's control gets a PUT
    // of no faults, so a gate that let one through could only calm b, never break a run.
    const worker401 = [];
    for (const path of keyedRoutes)
      for (const [who, headers] of [
        ["unkeyed", {}],
        ["wrong-key", { authorization: "Bearer wrong-key-of-the-right-length-000000" }],
      ]) {
        const init =
          path === profileControlPath
            ? { method: "PUT", headers, body: JSON.stringify({ rateLimitRate: 0, latencyMs: 0 }) }
            : { headers };
        const label = `${who} ${path}`;
        worker401.push({ call: label, status: (await call(base, label, path, init)).status });
      }
    const streaming = Promise.all(
      Object.keys(paths).flatMap((shape) => [
        streamed(base, shape, false),
        streamed(base, shape, true),
      ]),
    );
    // The non-streamed calls answer once the mock is up, so the profile calls after them meet a
    // warm mock: only profile b's own latency can then hold its answer back.
    const wholes = await Promise.all(
      Object.keys(paths).map((shape) =>
        model(base, shape, { kind: "non-streamed", stream: false }),
      ),
    );
    const profiles = await profileCheck({
      base,
      key,
      call,
      model: (shape, options) => model(base, shape, options),
    });
    const streams = await streaming;
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
    save("check", {
      deleteBy: new Date(deleteBy).toISOString(),
      worker401,
      refusal,
      streams,
      wholes,
      profiles,
    });
    for (const row of [...streams, ...wholes])
      summary(
        `- ${row.shape} ${row.kind}: HTTP ${row.status ?? "-"}, ${row.ms ?? "-"} ms, usage ${row.input ?? "-"} in / ${row.output ?? "-"} out, ${row.pass ? "passes" : `fails: ${row.reason}`}`,
      );
    for (const line of profileSummary(profiles)) summary(line);
    summary(
      `- the Worker without the key / with a wrong key, on ${keyedRoutes.join(", ")}: HTTP ${worker401.map((row) => row.status).join(", ")}`,
    );
    summary(
      `- the mock itself without the key / with a wrong key: ${[refusal.missing, refusal.wrong].map((row) => (row ? `HTTP ${row.status}${row.aimock ? " (aimock)" : ""}` : `none (HTTP ${refusal.status ?? "-"})`)).join(", ")}`,
    );
    summary(`- lease ends ${new Date(deleteBy).toISOString()}`);
    const failed = checkFailures({ worker401, refusal, streams, wholes, profiles });
    if (failed.length) throw new StageError(`Emulated upstream check failed: ${failed.join("; ")}`);
  }

  async function destroy() {
    const { before, failures, kept = [] } = await api.destroy();
    // Closed values only: a kept entry's type is on kept-entries.mjs's list, its class one of two.
    // The account proved each one in this run: refused as kept, and found again after.
    const keptFacts = kept.map(({ type, class: refused }) => ({ type, class: refused }));
    save("teardown", { before: counts(before), failures: failures.length, kept: keptFacts });
    summary(`- removed: ${api.describe(before) || "nothing was deployed"}`);
    if (keptFacts.length === 0)
      summary(
        `- after teardown: no container application, Worker, Durable Object namespace or tagged image named ${prefix}-*`,
      );
    else {
      const classes = new Map();
      for (const { type, class: refused } of keptFacts) {
        const what = `${type}, delete refused ${refused}`;
        classes.set(what, (classes.get(what) ?? 0) + 1);
      }
      summary(
        `- after teardown: no container application, Worker, Durable Object namespace or tag named ${prefix}-* remains; ${keptFacts.length} ${keptFacts.length === 1 ? "entry is" : "entries are"} kept by the registry: ${[...classes].map(([what, count]) => `${count} × ${what}`).join("; ")}`,
      );
    }
    summary("- not checked: a manifest the registry's tag list does not name");
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

  /**
   * After a deploy, the platform can take a while to hand the mock's Durable Object a container
   * instance. Waits for the mock to answer, a try every `mockWaitPauseMs` for at most
   * `mockWaitBoundMs`, and fails with the first reason it was given when that is plain words, or
   * its status otherwise.
   */
  async function waitForMock() {
    // A deploy that left no Worker says so now, not as a timeout.
    await leased();
    const base = await origin();
    const started = now();
    let firstCause;
    for (;;) {
      const answer = await call(
        base,
        "mock start",
        "/health",
        {
          headers: { authorization: `Bearer ${key}` },
          // A try gets only what is left of the bound, so the wait never outlasts it.
          signal: AbortSignal.timeout(Math.max(1, mockWaitBoundMs - (now() - started))),
        },
        (response) => (response.ok ? response.body?.cancel() : response.json().catch(() => ({}))),
      ).catch((error) => ({ status: undefined, ok: false, failed: publicMessage(error) }));
      if (answer.ok) {
        summary(
          `- the mock answered ${Math.round((now() - started) / 1_000)} s after the deploy (bound ${mockWaitBoundMs / 1_000} s)`,
        );
        return;
      }
      // The Worker's reason is printed only when it is plain words; anything else is its status.
      firstCause ??=
        answer.failed ??
        (answer.status === 503 && answer.body?.error?.type === "mock_unavailable"
          ? plainReason(answer.body.error.message)
          : undefined) ??
        `HTTP ${answer.status}`;
      if (now() - started + mockWaitPauseMs >= mockWaitBoundMs)
        throw new StageError(
          `The mock did not answer within ${mockWaitBoundMs / 1_000} s of the deploy: ${firstCause}`,
        );
      await wait(mockWaitPauseMs);
    }
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
    await waitForMock();
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
    // A stop of the account layer can carry a record of closed facts (tag-pages.mjs); it is kept
    // before the run ends, per mode, so a teardown after a failed deploy keeps the deploy's.
    if (
      (isCloudflareApiError(caught) || caught instanceof StageError) &&
      Object.hasOwn(caught, "record")
    ) {
      io.summary?.(`- stop record: ${JSON.stringify(caught.record)}`);
      io.save?.(`stopped-${mode}`, caught.record);
    }
    return 1;
  }
}
