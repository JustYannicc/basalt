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
  status: Schema.Struct({ state: Schema.Literal("running") }),
  image: Schema.NonEmptyString,
});
const Pagination = Schema.Struct({ next_page_token: Schema.optional(Schema.String) });
export class ProviderObservationRefused extends Error {
  readonly status = "unknown";
  readonly code: "provider_observation_refused" | "provider_fetch_failed";
  constructor(code: ProviderObservationRefused["code"] = "provider_observation_refused") {
    super("Pool provider observation refused");
    this.code = code;
  }
}

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
        instances = await this.instances(base, expected, signal);
        if (!instances.includes(instanceId)) throw new ProviderObservationRefused();
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
  async absent(
    expected: RuntimeProviderTarget,
    instanceId: string,
    signal = AbortSignal.timeout(15_000),
  ) {
    try {
      if (!/^[a-f0-9]{32}$/u.test(expected.accountId) || !expected.applicationId || !instanceId)
        return false;
      const at = this.now();
      const base = `https://api.cloudflare.com/client/v4/accounts/${expected.accountId}/containers/applications/${encodeURIComponent(expected.applicationId)}`;
      const before = decodeProviderApplication((await this.read(base, signal)).result);
      await this.prove(before, expected);
      const instances = await this.instances(base, expected, signal);
      const after = decodeProviderApplication((await this.read(base, signal)).result);
      await this.prove(after, expected);
      return (
        this.now() - at <= 30_000 &&
        canonicalProviderValue(before) === canonicalProviderValue(after) &&
        !instances.includes(instanceId)
      );
    } catch {
      return false;
    }
  }
  private async instances(base: string, expected: RuntimeProviderTarget, signal: AbortSignal) {
    const ids = new Set<string>(),
      tokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < 100; page++) {
      const query = new URLSearchParams({ state: "active", per_page: "100" });
      if (token) query.set("page_token", token);
      const reply = await this.read(`${base}/instances-v2?${query}`, signal);
      for (const value of Schema.decodeUnknownSync(Schema.Array(Instance))(reply.result)) {
        if (
          ids.has(value.id) ||
          value.application_id !== expected.applicationId ||
          !value.image.endsWith(`@${expected.imageDigest}`)
        )
          throw new ProviderObservationRefused();
        ids.add(value.id);
      }
      const next = Schema.decodeUnknownSync(Pagination)(reply.result_info).next_page_token;
      if (next === undefined || next === "") return [...ids].sort();
      if (tokens.has(next)) throw new ProviderObservationRefused();
      tokens.add(next);
      token = next;
    }
    throw new ProviderObservationRefused();
  }
}
