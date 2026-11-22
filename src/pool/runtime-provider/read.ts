import { Schema } from "effect";
import {
  ProviderApplicationProof,
  ProviderRuntimeProof,
} from "../runtime-slots/admission-proof.ts";
import { decodeProviderApplication, type ContainerAttributes } from "./application.ts";
import { canonicalProviderValue, providerDigest } from "./canonical.ts";
import { runtimeApplicationSettings } from "./settings.ts";

export interface RuntimeProviderTarget {
  accountId: string;
  applicationId: string;
  namespaceId: string;
  applicationVersion: string;
  imageDigest: string;
  applicationConfigDigest: string;
}
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;
const Envelope = Schema.Struct({
  success: Schema.Literal(true),
  errors: Schema.Array(Schema.Unknown),
  result: Schema.Unknown,
  result_info: Schema.optional(Schema.Unknown),
});
const Instance = Schema.Struct({
  id: Schema.NonEmptyString,
  application_id: Schema.NonEmptyString,
  status: Schema.Struct({ state: Schema.NonEmptyString }),
  image: Schema.NonEmptyString,
});
/**
 * Cloudflare's API reference for GET .../containers/applications/{id}/instances-v2 enumerates
 * `status.state`. The list's own `state=active` filter is another axis: a destroyed instance stays
 * listed there as "inactive" (seen on production on 22 Nov 2026, over an hour after the destroy).
 */
const documentedStates = new Set([
  "provisioning",
  "running",
  "failed",
  "stopping",
  "stopped",
  "unhealthy",
  "inactive",
  "unknown",
]);
/**
 * The closed stopped list is exactly "inactive", the state production reported for a destroyed
 * instance. The reference does not say what inactive means or whether such an instance can start
 * again; it reports the application's configured image for an instance without a placement, which
 * suggests inactive means no placement. That is an assumption. "stopped" and "failed" are not in
 * it: their Durable Object can start them again, so they count as present, each with its own
 * reason. What keeps a retired instance stopped is the endpoint's retired record, which its start
 * refuses; an admit over that record is not refused, and no current path reaches it.
 */
const stopped = (state: string) => state === "inactive";
/** Any other instance that may still run refuses the whole read, as any answer but running did. */
const unsettled = (state: string) => state !== "running" && !stopped(state);
/** Given only by a caller whose driver independently reported this exact boot stopped. */
export interface DriverStopped {
  readonly driverStopped: true;
}
/** Why an absence proof failed, as one closed value. */
type AbsenceRefusal =
  | "invalid"
  | "read"
  | "proof"
  | "instances"
  | "unknown_state"
  | "slow"
  | "stopped"
  | "failed"
  | "listed";
const Pagination = Schema.Struct({ next_page_token: Schema.optional(Schema.String) });
export class ProviderObservationRefused extends Error {
  readonly status = "unknown";
  readonly code: "provider_observation_refused" | "provider_fetch_failed";
  constructor(code: ProviderObservationRefused["code"] = "provider_observation_refused") {
    super("Pool provider observation refused");
    this.code = code;
  }
}
/** A state outside the documented list: never absent, never proof, and named on its own. */
class UndocumentedInstanceState extends ProviderObservationRefused {}

/** A read-only credential observes actual provider state; desired bindings never stand in for it. */
export class RuntimeProviderReader {
  private token: string | { get(): Promise<string | null> } | undefined;
  private fetcher: Fetcher;
  private now: () => number;
  constructor(
    token: RuntimeProviderReader["token"],
    fetcher: Fetcher = (input, init) => fetch(input, init),
    now = Date.now,
  ) {
    this.token = token;
    // Native fetch rejects a reader instance as its receiver.
    this.fetcher = fetcher;
    this.now = now;
  }
  private async credential(signal: AbortSignal) {
    signal.throwIfAborted();
    if (typeof this.token === "string") return this.token;
    const pending = this.token?.get();
    return new Promise<string | null | undefined>((resolve, reject) => {
      const abort = () => reject(new ProviderObservationRefused());
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve(pending).then(
        (value) => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        () => {
          signal.removeEventListener("abort", abort);
          reject(new ProviderObservationRefused());
        },
      );
    });
  }
  private async fetchResponse(url: string, init: RequestInit) {
    try {
      const fetcher = this.fetcher;
      return await fetcher(url, init);
    } catch {
      throw new ProviderObservationRefused("provider_fetch_failed");
    }
  }
  private async read(url: string, signal: AbortSignal) {
    try {
      // Resolve on each observation so provisioning or rotation needs no Worker restart.
      const token = await this.credential(signal);
      if (!token) throw new ProviderObservationRefused();
      const response = await this.fetchResponse(url, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel();
        throw new ProviderObservationRefused();
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = "",
        bytes = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 2_000_000) throw new ProviderObservationRefused();
          text += decoder.decode(next.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      const result = Schema.decodeUnknownSync(Envelope)(JSON.parse(text));
      if (result.errors.length) throw new ProviderObservationRefused();
      return result;
    } catch (error) {
      if (error instanceof ProviderObservationRefused) throw error;
      throw new ProviderObservationRefused();
    }
  }
  async observe(
    expected: RuntimeProviderTarget,
    instanceId?: string,
    signal = AbortSignal.timeout(15_000),
  ) {
    try {
      if (
        !/^[a-f0-9]{32}$/u.test(expected.accountId) ||
        !expected.applicationId ||
        !expected.namespaceId
      )
        throw new ProviderObservationRefused();
      const observedAt = this.now();
      const base = `https://api.cloudflare.com/client/v4/accounts/${expected.accountId}/containers/applications/${encodeURIComponent(expected.applicationId)}`;
      const application = async () => {
        const value = decodeProviderApplication((await this.read(base, signal)).result);
        await this.prove(value, expected);
        return value;
      };
      const before = await application();
      let instances: string[] | undefined;
      if (instanceId !== undefined) {
        const listed = await this.instances(base, expected, signal);
        // The named instance must run; an inactive sibling holds no compute, any other refuses.
        if (
          !listed.some((value) => value.id === instanceId && value.state === "running") ||
          listed.some((value) => value.id !== instanceId && unsettled(value.state))
        )
          throw new ProviderObservationRefused();
        instances = listed.filter((value) => !stopped(value.state)).map((value) => value.id);
        const after = await application();
        if (canonicalProviderValue(before) !== canonicalProviderValue(after))
          throw new ProviderObservationRefused();
      }
      if (this.now() - observedAt > 30_000 || observedAt > this.now() + 5_000)
        throw new ProviderObservationRefused();
      const proof = {
        ...expected,
        observedAt,
        observationDigest: await providerDigest({
          application: before,
          ...(instances ? { instances } : {}),
        }),
      };
      return instanceId === undefined
        ? Schema.decodeUnknownSync(ProviderApplicationProof)(proof)
        : Schema.decodeUnknownSync(ProviderRuntimeProof)({ ...proof, instanceId });
    } catch (error) {
      if (error instanceof ProviderObservationRefused) throw error;
      throw new ProviderObservationRefused();
    }
  }
  private async prove(value: ContainerAttributes, expected: RuntimeProviderTarget) {
    if (
      value.accountId !== expected.accountId ||
      value.applicationId !== expected.applicationId ||
      String(value.version) !== expected.applicationVersion ||
      value.durableObjects?.namespaceId !== expected.namespaceId ||
      value.configuration.image.split("@")[1] !== expected.imageDigest ||
      value.activeRolloutId ||
      (await providerDigest(runtimeApplicationSettings(value))) !== expected.applicationConfigDigest
    )
      throw new ProviderObservationRefused();
  }
  /**
   * Absent means not listed. With the driver's own report that this boot stopped, an instance the
   * provider lists only as inactive is absent too; nothing else stands in for the provider.
   */
  async absent(
    expected: RuntimeProviderTarget,
    instanceId: string,
    signal = AbortSignal.timeout(15_000),
    driver?: DriverStopped,
  ) {
    if (!instanceId) return false;
    return this.absence(expected, signal, instanceId, driver?.driverStopped === true);
  }
  empty(expected: RuntimeProviderTarget, signal = AbortSignal.timeout(15_000)) {
    return this.absence(expected, signal);
  }
  private async absence(
    expected: RuntimeProviderTarget,
    signal: AbortSignal,
    instanceId?: string,
    driverStopped = false,
  ) {
    const refusal = await this.absenceRefusal(expected, signal, instanceId, driverStopped);
    // Retirement polls this every fleet tick; the reason is closed and names no runtime.
    if (refusal) console.info("POOL_PROVIDER_ABSENCE", { reason: refusal });
    return refusal === undefined;
  }
  private async absenceRefusal(
    expected: RuntimeProviderTarget,
    signal: AbortSignal,
    instanceId: string | undefined,
    driverStopped: boolean,
  ): Promise<AbsenceRefusal | undefined> {
    let stage: AbsenceRefusal = "invalid";
    try {
      if (!/^[a-f0-9]{32}$/u.test(expected.accountId) || !expected.applicationId) return "invalid";
      stage = "read";
      const at = this.now();
      const base = `https://api.cloudflare.com/client/v4/accounts/${expected.accountId}/containers/applications/${encodeURIComponent(expected.applicationId)}`;
      const before = decodeProviderApplication((await this.read(base, signal)).result);
      stage = "proof";
      await this.prove(before, expected);
      stage = "instances";
      const listed = await this.instances(base, expected, signal);
      stage = "read";
      const after = decodeProviderApplication((await this.read(base, signal)).result);
      stage = "proof";
      await this.prove(after, expected);
      if (canonicalProviderValue(before) !== canonicalProviderValue(after)) return "proof";
      if (this.now() - at > 30_000) return "slow";
      // An empty application has no listed instance at all, a stopped one included.
      if (instanceId === undefined) return listed.length > 0 ? "listed" : undefined;
      if (listed.some((value) => value.id !== instanceId && unsettled(value.state)))
        return "instances";
      const target = listed.find((value) => value.id === instanceId);
      if (!target || (driverStopped && stopped(target.state))) return undefined;
      return target.state === "stopped" || target.state === "failed" ? target.state : "listed";
    } catch (error) {
      return error instanceof UndocumentedInstanceState ? "unknown_state" : stage;
    }
  }
  private async instances(base: string, expected: RuntimeProviderTarget, signal: AbortSignal) {
    const states = new Map<string, string>(),
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ state: "active", per_page: "100" });
      if (token) query.set("page_token", token);
      const reply = await this.read(`${base}/instances-v2?${query}`, signal);
      for (const value of Schema.decodeUnknownSync(Schema.Array(Instance))(reply.result)) {
        const state = value.status.state;
        if (!documentedStates.has(state)) throw new UndocumentedInstanceState();
        if (
          states.has(value.id) ||
          value.application_id !== expected.applicationId ||
          // A running instance must run the admitted image; the callers judge every other state.
          (state === "running" && !value.image.endsWith(`@${expected.imageDigest}`))
        )
          throw new ProviderObservationRefused();
        states.set(value.id, value.status.state);
      }
      const next = Schema.decodeUnknownSync(Pagination)(reply.result_info).next_page_token;
      if (next === undefined || next === "")
        return [...states.keys()].sort().map((id) => ({ id, state: states.get(id)! }));
      if (tokens.has(next)) throw new ProviderObservationRefused();
      tokens.add(next);
      token = next;
    }
    throw new ProviderObservationRefused();
  }
}
