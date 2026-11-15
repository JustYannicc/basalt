import { randomUUID } from "node:crypto";
import { callerHeader } from "../../apps/pool/contract.ts";
import {
  hostAssertionTtlMs,
  isSigningKey,
  signEnvelope,
  signPoolToken,
} from "../../src/pool/token.ts";
import {
  nativeControlPath,
  nativeControlPrefix,
  nativeModelHeader,
  nativeModelPrefix,
} from "../../src/pool/native-contract.ts";
import { previewPlanQuotaAvailable } from "./pool-grant-quota.ts";
import { openPreviewModelProxy, previewModel } from "./pool-grant-proxy.ts";

export interface PreviewPoolGrantConfig {
  poolId: string;
  organizationId: string;
  ownerId: string;
  signingKey: string;
  origin: string;
}
export interface PreviewPoolGrantOptions {
  fetch?: typeof fetch;
  now?: () => number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 16_384;
type Failure =
  | "inputs"
  | "transport"
  | "quota"
  | "setup"
  | "revoke"
  | "probe"
  | "close"
  | "setup_cleanup";
export class PreviewPoolGrantFailure extends Error {
  readonly kind: Failure;
  constructor(kind: Failure) {
    super(`Preview pool grant failed: ${kind}`);
    this.name = "PreviewPoolGrantFailure";
    this.kind = kind;
  }
}

/** A native grant keeps its real model key on the server and gives CI no production tools. */
export async function openPreviewPoolGrant(
  config: PreviewPoolGrantConfig,
  options: PreviewPoolGrantOptions = {},
) {
  let origin: string;
  try {
    const url = new URL(config.origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== config.origin ||
      !isSigningKey(config.signingKey) ||
      ![config.poolId, config.organizationId, config.ownerId].every(
        (id) => text(id) && id.length <= 512,
      )
    )
      throw 0;
    origin = url.origin;
  } catch {
    throw new PreviewPoolGrantFailure("inputs");
  }
  const transport = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const grant = `native:preview-${randomUUID()}`;
  const name = `Preview model ${randomUUID()}`;
  const previousIds = new Set<string>();
  let computerId: string | undefined;
  let registrationAttempted = false;
  let requests = 0;
  let closed = false;
  let closing: Promise<{ revoked: true; unauthorized: true }> | undefined;
  let proxy: Awaited<ReturnType<typeof openPreviewModelProxy>> | undefined;
  const call = async (path: string, init: RequestInit = {}) => {
    try {
      return await transport(
        new Request(new URL(path, origin), {
          ...init,
          redirect: "manual",
          signal: init.signal ?? AbortSignal.timeout(30_000),
        }),
      );
    } catch {
      throw new PreviewPoolGrantFailure("transport");
    }
  };
  const read = async (response: Response, kind: Failure) => {
    try {
      if (!response.ok) {
        await response.body?.cancel();
        throw 0;
      }
      const reader = response.body?.getReader();
      if (!reader) throw 0;
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 1024 * 1024) {
          await reader.cancel();
          throw 0;
        }
        chunks.push(chunk.value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new PreviewPoolGrantFailure(kind);
    }
  };
  const poolHeaders = async () => ({
    authorization: `Bearer ${await signPoolToken(config.signingKey, {
      pool: config.poolId,
      owner: config.ownerId,
      organization: config.organizationId,
      exp: Math.floor(now() / 1000) + 30,
    })}`,
    [callerHeader]: config.ownerId,
  });
  const quota = async () => {
    const value = await read(
      await call("/pool/v1/pool?fresh=true", { headers: await poolHeaders() }),
      "quota",
    );
    if (!previewPlanQuotaAvailable(value, now())) throw new PreviewPoolGrantFailure("quota");
  };
  const context = async () => {
    const value = await read(
      await call("/pool/v1/setup-context", { headers: await poolHeaders() }),
      "setup",
    );
    if (!object(value) || !text(value.intent) || !Array.isArray(value.computers))
      throw new PreviewPoolGrantFailure("setup");
    return { intent: value.intent, computers: value.computers };
  };
  const identity = () => ({
    user: config.ownerId,
    grant,
    computer: computerId,
    pool: config.poolId,
  });
  const control = async (action: string, payload: Record<string, unknown>, kind: Failure) => {
    const envelope = await signEnvelope(config.signingKey, nativeControlPrefix, {
      ...payload,
      action,
      expiresAt: now() + hostAssertionTtlMs,
    });
    return read(
      await call(nativeControlPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
      }),
      kind,
    );
  };
  const modelRequest = async (body: string, version: string, signal?: AbortSignal) => {
    const assertion = await signEnvelope(config.signingKey, nativeModelPrefix, {
      ...identity(),
      method: "POST",
      path: "/v1/messages",
      expiresAt: now() + hostAssertionTtlMs,
    });
    return call("/v1/messages", {
      method: "POST",
      signal,
      body,
      headers: {
        "content-type": "application/json",
        "anthropic-version": version,
        [nativeModelHeader]: assertion,
      },
    });
  };
  const revoke = async () => {
    if (!computerId) throw new PreviewPoolGrantFailure("revoke");
    const result = await control("revoke", identity(), "revoke");
    if (!object(result) || result.revoked !== true) throw new PreviewPoolGrantFailure("revoke");
    const response = await modelRequest(
      JSON.stringify({
        model: previewModel,
        max_tokens: 1,
        messages: [{ role: "user", content: "OK" }],
      }),
      "2023-06-01",
    );
    await response.body?.cancel();
    if (response.status !== 401 && response.status !== 403)
      throw new PreviewPoolGrantFailure("probe");
  };
  try {
    await quota();
    const setup = await context();
    for (const row of setup.computers) if (object(row) && text(row.id)) previousIds.add(row.id);
    registrationAttempted = true;
    const created = await control(
      "register",
      {
        user: config.ownerId,
        grant,
        models: true,
        tools: false,
        intent: setup.intent,
        name,
      },
      "setup",
    );
    if (object(created) && object(created.computer) && text(created.computer.id))
      computerId = created.computer.id;
    if (
      !computerId ||
      !object(created) ||
      created.pool !== config.poolId ||
      created.models !== true ||
      created.toolsOrganization !== undefined ||
      !object(created.computer) ||
      created.computer.tools !== false ||
      created.computer.state !== "active"
    )
      throw new PreviewPoolGrantFailure("setup");
    proxy = await openPreviewModelProxy(async (body, version, signal) => {
      if (closed) throw new PreviewPoolGrantFailure("close");
      await quota();
      signal.throwIfAborted();
      if (closed) throw new PreviewPoolGrantFailure("close");
      requests++;
      return modelRequest(body, version, signal);
    });
  } catch (error) {
    if (registrationAttempted) {
      try {
        // Never repeat a registration whose response was lost. Inspect the unique run name instead.
        if (!computerId) {
          const matches = (await context()).computers.filter(
            (row) =>
              object(row) &&
              row.name === name &&
              row.poolId === config.poolId &&
              text(row.id) &&
              !previousIds.has(row.id),
          );
          if (matches.length !== 1 || !object(matches[0]) || !text(matches[0].id)) throw 0;
          computerId = matches[0].id;
        }
        await revoke();
      } catch {
        throw new PreviewPoolGrantFailure("setup_cleanup");
      }
    }
    throw error instanceof PreviewPoolGrantFailure ? error : new PreviewPoolGrantFailure("setup");
  }
  const activeProxy = proxy;
  return {
    modelUrl: activeProxy.modelUrl,
    modelKey: activeProxy.modelKey,
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        let shutdownFailed = false;
        try {
          await activeProxy.close();
        } catch {
          shutdownFailed = true;
        }
        await revoke();
        if (shutdownFailed) throw new PreviewPoolGrantFailure("close");
        return { revoked: true, unauthorized: true } as const;
      })().catch((error: unknown) => {
        throw error instanceof PreviewPoolGrantFailure
          ? error
          : new PreviewPoolGrantFailure("close");
      });
      return closing;
    },
    evidence: () =>
      ({
        model: previewModel,
        requests,
        planQuotaChecked: true,
        extraUsageDisabled: true,
      }) as const,
  };
}
