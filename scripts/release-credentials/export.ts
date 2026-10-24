import { brand } from "../../brand.ts";
import { callerHeader } from "../../apps/pool/contract.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { credentialSecretNames, exportTimeoutMs, maxExportBytes, maxGitHubSecretBytes } from "./constants.ts";
import { setGitHubSecret, type GitHubSecretWriter } from "./github-secret.ts";

export { credentialSecretNames, maxExportBytes, maxGitHubSecretBytes } from "./constants.ts";

type Provider = keyof typeof credentialSecretNames;

export interface ExportInputs {
  readonly ref: string;
  readonly eventName: string;
  readonly dedicatedThrowawayAccounts: string;
  readonly poolId: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly claudeAccountId: string;
  readonly codexAccountId: string;
  readonly signingKey: string;
  readonly releaseToken: string;
  readonly repository: string;
}

export interface ExportDependencies {
  readonly fetch?: typeof fetch;
  readonly writeSecret?: GitHubSecretWriter;
}

type FailureKind = "ref" | "confirmation" | "inputs" | "export" | "secret";

const failureMessages: Record<FailureKind, string> = {
  ref: "Credential export requires workflow_dispatch on refs/heads/main.",
  confirmation: "Credential export requires dedicated throwaway account confirmation.",
  inputs: "Credential export inputs are invalid.",
  export: "Credential export failed. No credentials were written.",
  secret: "Credential secret update failed. One or more secrets may have changed.",
};

export class CredentialExportFailure extends Error {
  readonly kind: FailureKind;

  constructor(kind: FailureKind) {
    super(failureMessages[kind]);
    this.name = "CredentialExportFailure";
    this.kind = kind;
  }
}

export function safeCredentialExportMessage(error: unknown): string {
  return error instanceof CredentialExportFailure ? failureMessages[error.kind] : failureMessages.export;
}

interface ValidatedInputs {
  readonly poolId: string;
  readonly organizationId: string;
  readonly ownerId: string;
  readonly claudeAccountId: string;
  readonly codexAccountId: string;
  readonly signingKey: string;
  readonly releaseToken: string;
  readonly repository: string;
}

function isOpaqueId(value: string): boolean {
  return value.length > 0 && new TextEncoder().encode(value).byteLength <= 512 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && value.trim() === value;
}

function validateInputs(input: ExportInputs): ValidatedInputs {
  const poolId = /^app_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.poolId);
  const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository);
  const secret = input.releaseToken.length > 0 && input.releaseToken.length <= 8192 &&
    !/[\u0000\r\n]/.test(input.releaseToken);
  const signingKey = /^[0-9a-f]{64}$/.test(input.signingKey);
  if (
    !poolId || !repository || !secret || !signingKey ||
    ![input.organizationId, input.ownerId, input.claudeAccountId, input.codexAccountId].every(isOpaqueId)
  ) throw new CredentialExportFailure("inputs");

  return {
    poolId: input.poolId,
    organizationId: input.organizationId,
    ownerId: input.ownerId,
    claudeAccountId: input.claudeAccountId,
    codexAccountId: input.codexAccountId,
    signingKey: input.signingKey,
    releaseToken: input.releaseToken,
    repository: input.repository,
  };
}

function rejectResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function readBoundedBody(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d{1,20}$/.test(contentLength) && BigInt(contentLength) > BigInt(maxExportBytes)) {
    rejectResponseBody(response);
    throw new CredentialExportFailure("export");
  }

  if (!response.body) throw new CredentialExportFailure("export");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxExportBytes) {
        void reader.cancel().catch(() => {});
        throw new CredentialExportFailure("export");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof CredentialExportFailure) throw error;
    throw new CredentialExportFailure("export");
  } finally {
    try { reader.releaseLock(); } catch { /* The response is discarded after any read failure. */ }
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CredentialExportFailure("export");
  }
}

async function exportAccount(
  provider: Provider,
  accountId: string,
  token: string,
  ownerId: string,
  fetcher: typeof fetch,
): Promise<string> {
  let response: Response;
  try {
    const url = `https://${brand.host}/pool/v1/accounts/${encodeURIComponent(accountId)}/export?provider=${provider}`;
    response = await fetcher(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        [callerHeader]: ownerId,
      },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(exportTimeoutMs),
    });
  } catch {
    throw new CredentialExportFailure("export");
  }

  if (!response.ok) {
    rejectResponseBody(response);
    throw new CredentialExportFailure("export");
  }

  const raw = await readBoundedBody(response);
  let value: unknown;
  try { value = JSON.parse(raw) as unknown; } catch {
    throw new CredentialExportFailure("export");
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).type !== provider) {
    throw new CredentialExportFailure("export");
  }
  if (new TextEncoder().encode(raw).byteLength > maxGitHubSecretBytes) {
    throw new CredentialExportFailure("export");
  }
  return raw;
}

export async function exportPreviewCredentials(
  input: ExportInputs,
  dependencies: ExportDependencies = {},
): Promise<void> {
  if (input.eventName !== "workflow_dispatch" || input.ref !== "refs/heads/main") {
    throw new CredentialExportFailure("ref");
  }
  if (input.dedicatedThrowawayAccounts !== "true") {
    throw new CredentialExportFailure("confirmation");
  }

  const validated = validateInputs(input);
  let token: string;
  try {
    token = await signPoolToken(validated.signingKey, {
      pool: validated.poolId,
      organization: validated.organizationId,
      owner: validated.ownerId,
    });
  } catch {
    throw new CredentialExportFailure("export");
  }

  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const claude = await exportAccount("claude", validated.claudeAccountId, token, validated.ownerId, fetcher);
  const codex = await exportAccount("codex", validated.codexAccountId, token, validated.ownerId, fetcher);
  const writeSecret = dependencies.writeSecret ?? setGitHubSecret;
  try {
    await writeSecret(credentialSecretNames.claude, claude, validated.releaseToken, validated.repository);
    await writeSecret(credentialSecretNames.codex, codex, validated.releaseToken, validated.repository);
  } catch {
    throw new CredentialExportFailure("secret");
  }
}
