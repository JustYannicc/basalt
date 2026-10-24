export interface ZohoPatchDigest {
  readonly path: string;
  readonly sha256: string;
}

export interface ZohoSourcePin {
  readonly candidateCommit: string;
  readonly baseCommit: string;
  readonly candidateTree: string;
  readonly runtimeCommit: string;
  readonly patches: readonly ZohoPatchDigest[];
}

export interface ZohoFailureEnvelope {
  readonly stage: string;
  readonly kind: string;
  readonly message: string;
}

export function digest(value: string | Uint8Array): string;
export function pinProofSource(
  root: string,
  candidateCommit: string,
  baseCommit: string,
): ZohoSourcePin;
export function boundedFailure(
  stage: string,
  error: unknown,
  privateValues?: readonly string[],
): ZohoFailureEnvelope;
