import { canonical, digest } from "./manifest.ts";

export interface ReleaseOperationReceipt<I, R> {
  candidate: string;
  fingerprint: string;
  intent: I;
  status: "pending" | "complete";
  sent?: true;
  result?: R;
}

export interface ReleaseOperationInspection<R> {
  status: "pending" | "complete";
  result?: R;
}

export interface PlannedReleaseOperation<I, R> {
  candidate: string;
  mode: string;
  existing?: ReleaseOperationReceipt<I, R>;
  plan(): Promise<I>;
  execute(intent: I): Promise<R>;
  inspect(intent: I): Promise<ReleaseOperationInspection<R>>;
  save(receipt: ReleaseOperationReceipt<I, R>): Promise<void>;
}

type Failure =
  | "candidate-invalid"
  | "mode-invalid"
  | "candidate-mismatch"
  | "receipt-invalid"
  | "intent-invalid"
  | "plan-failed"
  | "plan-stale"
  | "save-failed";

export class ReleaseOperationError extends Error {
  readonly reason: Failure;
  constructor(reason: Failure) {
    super(`release-operation-${reason}`);
    this.name = "ReleaseOperationError";
    this.reason = reason;
  }
}

export function releaseOperationFingerprint<I>(candidate: string, intent: I) {
  try {
    return digest(canonical({ candidate, intent }));
  } catch {
    throw new ReleaseOperationError("intent-invalid");
  }
}

function snapshot<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new ReleaseOperationError("intent-invalid");
  }
}

/** The caller serializes journal access and supplies only safe intent and result fields. */
export async function runPlannedReleaseOperation<I, R>(
  options: PlannedReleaseOperation<I, R>,
): Promise<ReleaseOperationReceipt<I, R>> {
  const { candidate, mode } = options;
  if (!/^[a-f0-9]{40}$/u.test(candidate)) throw new ReleaseOperationError("candidate-invalid");
  if (mode !== "plan" && mode !== "inspect" && !/^[a-f0-9]{64}$/u.test(mode))
    throw new ReleaseOperationError("mode-invalid");

  const plan = async (): Promise<ReleaseOperationReceipt<I, R>> => {
    let intent: I;
    try {
      intent = snapshot(await options.plan());
    } catch {
      throw new ReleaseOperationError("plan-failed");
    }
    return {
      candidate,
      fingerprint: releaseOperationFingerprint(candidate, intent),
      intent,
      status: "pending",
    };
  };
  let receipt = options.existing ? snapshot(options.existing) : await plan();
  if (receipt.candidate !== candidate) throw new ReleaseOperationError("candidate-mismatch");
  if (
    (receipt.status !== "pending" && receipt.status !== "complete") ||
    (receipt.sent !== undefined && receipt.sent !== true) ||
    receipt.fingerprint !== releaseOperationFingerprint(candidate, receipt.intent)
  )
    throw new ReleaseOperationError("receipt-invalid");
  if (mode === "plan") return receipt;

  const inspect = async () => {
    try {
      const observed = await options.inspect(snapshot(receipt.intent));
      if (observed.status !== "pending" && observed.status !== "complete") return receipt;
      return {
        ...receipt,
        status: observed.status,
        ...(observed.result === undefined ? {} : { result: snapshot(observed.result) }),
      };
    } catch {
      return receipt;
    }
  };
  if (mode === "inspect") return inspect();
  if (mode !== receipt.fingerprint) throw new ReleaseOperationError("plan-stale");
  // A completed digest is idempotent; its recorded result never triggers another callback.
  if (receipt.status === "complete") return receipt;

  const save = async (value: ReleaseOperationReceipt<I, R>) => {
    try {
      await options.save(snapshot(value));
    } catch {
      throw new ReleaseOperationError("save-failed");
    }
  };
  if (!receipt.sent) {
    // An unsent saved plan is not authority to act on material state that has since changed.
    if (options.existing && (await plan()).fingerprint !== mode)
      throw new ReleaseOperationError("plan-stale");
    receipt = { ...receipt, sent: true };
    await save(receipt);
    try {
      const result = snapshot(await options.execute(snapshot(receipt.intent)));
      receipt = { ...receipt, status: "complete", result };
    } catch {
      receipt = await inspect();
    }
  } else {
    // A pending send can have committed. Only observation may settle it, even on a fresh runner.
    receipt = await inspect();
  }
  if (receipt.status === "complete") await save(receipt);
  return receipt;
}
