/**
 * The selected runtime's readiness refuses on identity when the new pool Worker's runtime digest
 * differs from the one that runtime sealed at its start (src/pool/runtime-slots/endpoint.ts
 * `ready`). That refusal lands after the upload, with the new Worker already live, so the plan
 * computes the digest the new Worker will compute and compares it first. A digest the plan cannot
 * compute yet, or a seal it cannot read, is reported as not checked and never refuses a release.
 */
import { isResolved } from "alchemy/Diff";
import type * as Plan from "alchemy/Plan";
import { Data, Effect, Option, Redacted, Schema } from "effect";
import { StartupWitness } from "../../src/pool/runtime-slots/admission-proof.ts";
import {
  configurationDigest,
  runtimeConfiguration,
  type RuntimeConfiguration,
  type RuntimeEnvironment,
} from "../../src/pool/runtime-slots/configuration.ts";
import {
  SlotTarget,
  sameTarget,
  type ControllerCode,
} from "../../src/pool/runtime-slots/contract.ts";

export type FingerprintCheck =
  | { readonly checked: true }
  | { readonly checked: false; readonly reason: string };

/** What the plan learns of the selected runtime's seal before the upload. */
export type Sealed = { readonly fingerprint: string } | { readonly unknown: string };

/** One signed read-only handoff command, answered with the controller's reply (`{ result }`). */
export type SignedRead = (
  action: "inspect" | "witness",
  code: ControllerCode,
  slot?: SlotTarget,
) => Promise<unknown>;

// Only fixed text: the digest covers the database URL and both keys, so no value is ever named.
export class FingerprintRefused extends Data.TaggedError("FingerprintRefused")<{
  readonly check: string;
  readonly why: string;
  readonly fix: string;
}> {
  override get message() {
    return `${this.check}: ${this.why}`;
  }
}

/**
 * Before the upload the old pool Worker answers, and it refuses every signed handoff read that
 * does not name its exact controller code (src/pool/runtime-slots/http.ts). Nothing it serves
 * names that code: the readiness route answers a bare 409 to a target it does not run, the
 * declaration sets no version annotation, and the root's unsigned recovery read leaves it out.
 * The release knows only the candidate's code, which moves with every release commit. A read
 * signed with the deployment key that returns the Worker's own controller code, without the
 * caller naming it, is what would make the check possible.
 */
export const identityUnknownBeforeUpload: Sealed = {
  unknown: "the deployed controller's identity is not known before the upload",
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const names = (keys: ReadonlySet<string>) => [...keys].sort().join(", ");

/** The digest the new pool Worker will compare at readiness, or why the plan cannot know it yet. */
async function plannedRuntimeDigest(
  plan: Plan.Plan,
  poolWorker: string,
): Promise<{ digest: string } | { unknown: string }> {
  const node = plan.resources[poolWorker];
  if (!node || !("props" in node)) return { unknown: `the plan does not upload ${poolWorker}` };
  const props: unknown = node.props;
  const env = record(props) && record(props.env) ? props.env : undefined;
  if (!env) return { unknown: `${poolWorker} declares no readable env` };
  const unresolved = new Set<string>();
  const unreadable = new Set<string>();
  // Answers only the keys runtimeConfiguration reads, so a value it never reads (the database
  // readiness hash, which waits on a command) cannot stop the check.
  const planned = new Proxy({} as RuntimeEnvironment, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      const declared = env[key];
      const value = Redacted.isRedacted(declared) ? Redacted.value(declared) : declared;
      if (value === undefined || typeof value === "string") return value;
      (isResolved(value) ? unreadable : unresolved).add(key);
      return undefined;
    },
  });
  let configuration: RuntimeConfiguration | undefined;
  try {
    configuration = runtimeConfiguration(planned);
  } catch {
    configuration = undefined;
  }
  if (unresolved.size) return { unknown: `${names(unresolved)} unresolved in the plan` };
  if (unreadable.size) return { unknown: `${names(unreadable)} not text in the plan` };
  if (!configuration)
    return { unknown: `${poolWorker}'s planned env is not a runtime configuration` };
  return { digest: await configurationDigest(configuration) };
}

const InspectReply = Schema.Struct({
  result: Schema.Struct({
    selection: Schema.optional(
      Schema.NullOr(Schema.Struct({ active: Schema.Struct({ target: SlotTarget }) })),
    ),
  }),
});
const WitnessReply = Schema.Struct({
  result: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("witness"),
      witness: Schema.optional(
        Schema.Struct({
          target: SlotTarget,
          configurationFingerprint: StartupWitness.fields.configurationFingerprint,
        }),
      ),
    }),
    Schema.Struct({ kind: Schema.Literal("unattested-active") }),
  ]),
});

/**
 * The selected runtime's sealed fingerprint, read through the signed read-only `inspect` and
 * `witness` commands bound to the controller code the serving Worker accepts. An attested
 * runtime's attestation must equal its witness (endpoint.ts `attest`), so the witness is the seal.
 */
export async function sealedFingerprint(code: ControllerCode, read: SignedRead): Promise<Sealed> {
  let inspected: unknown;
  try {
    inspected = await read("inspect", code);
  } catch {
    return { unknown: "the signed inspect read failed" };
  }
  const selection = Schema.decodeUnknownOption(InspectReply)(inspected);
  if (Option.isNone(selection)) return { unknown: "the signed inspect reply is unreadable" };
  const target = selection.value.result.selection?.active.target;
  if (!target)
    return {
      unknown: "no runtime is selected, so readiness takes the legacy path and compares none",
    };
  let witnessed: unknown;
  try {
    witnessed = await read("witness", code, target);
  } catch {
    return { unknown: "the signed witness read failed" };
  }
  const witness = Option.getOrUndefined(
    Schema.decodeUnknownOption(WitnessReply)(witnessed),
  )?.result;
  if (!witness) return { unknown: "the signed witness reply is unreadable" };
  if (witness.kind === "unattested-active")
    return {
      unknown: "the selected runtime is an unattested adoption, which readiness refuses anyway",
    };
  if (!witness.witness || !sameTarget(witness.witness.target, target))
    return { unknown: "the selected runtime has no startup witness for its target" };
  return { fingerprint: witness.witness.configurationFingerprint };
}

const notChecked = (reason: string): FingerprintCheck => ({ checked: false, reason });

/** Refuses only a known difference; anything the plan cannot know comes back as not checked. */
export const checkRuntimeFingerprint = (
  plan: Plan.Plan,
  poolWorker: string,
  sealed: () => Promise<Sealed>,
) =>
  Effect.gen(function* () {
    const planned = yield* Effect.promise(() => plannedRuntimeDigest(plan, poolWorker));
    if ("unknown" in planned) return notChecked(planned.unknown);
    const seal = yield* Effect.promise(() =>
      sealed().catch((): Sealed => ({ unknown: "the signed read failed" })),
    );
    if ("unknown" in seal) return notChecked(seal.unknown);
    if (seal.fingerprint !== planned.digest)
      return yield* Effect.fail(
        new FingerprintRefused({
          check: "fingerprint differs",
          why: `The new ${poolWorker}'s runtime settings are not the ones the selected runtime sealed, so its readiness would refuse on identity after the upload.`,
          fix: "Release with the settings the selected runtime runs, or replace that runtime in its own reviewed release.",
        }),
      );
    const checked: FingerprintCheck = { checked: true };
    return checked;
  });

/** Not checked is loud: the public summary says so, and Actions shows it as a warning. */
export const fingerprintReport = (check: FingerprintCheck) =>
  check.checked
    ? {
        summary:
          "Runtime fingerprint checked: the new pool Worker's runtime settings are the ones the selected runtime sealed.",
      }
    : {
        summary: `**Fingerprint not checked**: ${check.reason}. Readiness after the upload still compares it, so a difference would stop the release in apply with the new Worker live.`,
        annotation: `::warning title=Fingerprint not checked::${check.reason}`,
      };
