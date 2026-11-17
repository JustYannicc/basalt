import { isRehearsalStage, productionRelease, rehearsalStack } from "../release-barrier/release-stage.ts";

/**
 * What a disposable stack exists for: one PR's preview, or one release rehearsal run. Everything a
 * stack is named or keyed by derives from this, so a PR and a rehearsal with the same number never
 * share a stage, stack, resource name, key or checkpoint.
 */
export type StageSubject = { readonly kind: "pr" | "rehearsal"; readonly number: number };

export interface StageNames {
  readonly slug: string;
  readonly stage: string;
  /** The Alchemy stack the application deploys into; the database parent has its own stack. */
  readonly stack: string;
  readonly sourceNamespace: string;
  readonly databaseName: string;
}

export const previewDatabaseStack = "basalt-preview-database";
/** A rehearsal's one-shot seed fixture; it exists only while it runs, and cleanup checks it too. */
export const rehearsalFixtureStack = "basalt-rehearsal-fixture";

export function stageSubject(kind: StageSubject["kind"], number: number): StageSubject {
  if (kind === "pr") {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("PR number must be a positive integer");
    return { kind, number };
  }
  if (kind !== "rehearsal") throw new Error("Unknown disposable stage kind");
  // The release barrier bounds rehearsal stages; a number it would refuse never gets a stack.
  if (!Number.isSafeInteger(number) || number < 1 || !isRehearsalStage(`test-rehearsal-${number}`))
    throw new Error("Rehearsal number must be a positive integer");
  return { kind, number };
}

export const pullRequestSubject = (number: number) => stageSubject("pr", number);
export const rehearsalSubject = (number: number) => stageSubject("rehearsal", number);

/** PR call sites still pass a bare number; it always means a pull request. */
export function toSubject(value: number | StageSubject): StageSubject {
  return typeof value === "number" ? pullRequestSubject(value) : stageSubject(value.kind, value.number);
}

export function stageNames(value: number | StageSubject): StageNames {
  const subject = toSubject(value);
  const slug = `${subject.kind}-${subject.number}`;
  return {
    slug,
    stage: `test-${slug}`,
    stack: subject.kind === "rehearsal" ? rehearsalStack : productionRelease.stack,
    sourceNamespace: `basalt-preview-${slug}-apps`,
    databaseName: `basalt-preview-${slug}`,
  };
}

/**
 * The subject that owns a disposable stage, or undefined for a stage outside both prefixes. A
 * malformed name under either prefix throws, so the deploy config can never read it as production.
 */
export function subjectFromStage(stage: string | undefined): StageSubject | undefined {
  if (stage === undefined || !/^test-(?:pr|rehearsal)-/.test(stage)) return undefined;
  const pr = /^test-pr-([1-9][0-9]*)$/.exec(stage)?.[1];
  if (pr !== undefined && Number.isSafeInteger(Number(pr))) return pullRequestSubject(Number(pr));
  if (isRehearsalStage(stage)) return rehearsalSubject(Number(stage.slice("test-rehearsal-".length)));
  throw new Error("Disposable stage name is malformed");
}

/** Delete and state-read configs serve only disposable stages; anything else stops here. */
export function requireDisposableStage(stage: string | undefined): StageSubject {
  const subject = subjectFromStage(stage);
  if (subject === undefined)
    throw new Error("Preview cleanup is restricted to PR and rehearsal stages.");
  return subject;
}

/**
 * The delete-only config names its stack from ALCHEMY_STAGE when it loads, before Alchemy provides
 * the stage, so the two must agree or a rehearsal could read and delete under the PR stack name.
 */
export function requireCleanupStage(stage: string, configured: string | undefined): StageSubject {
  const subject = requireDisposableStage(stage);
  if (stage !== configured)
    throw new Error("Preview cleanup stage does not match ALCHEMY_STAGE.");
  return subject;
}

/** `17` is a PR; `rehearsal-17` is a rehearsal. Nothing else can become a path or an option. */
export function parseSubjectArgument(value: string | undefined): StageSubject {
  if (value !== undefined && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)))
    return pullRequestSubject(Number(value));
  const rehearsal = value === undefined ? undefined : /^rehearsal-([1-9][0-9]*)$/.exec(value)?.[1];
  if (rehearsal !== undefined && isRehearsalStage(`test-rehearsal-${rehearsal}`))
    return rehearsalSubject(Number(rehearsal));
  throw new Error("An exact preview PR number or rehearsal-<N> is required");
}

/**
 * Separate HMAC and AAD domains. The PR strings are the ones previews have always used, so an
 * existing preview's keys and sealed checkpoints stay valid.
 */
export function subjectKeyDomain(subject: StageSubject): string {
  return subject.kind === "pr" ? "basalt-preview-v1" : "basalt-rehearsal-v1";
}

export function subjectManifestAad(subject: StageSubject): string {
  return `${subject.kind === "pr" ? "basalt-preview-manifest-v1" : "basalt-rehearsal-manifest-v1"}:${subject.number}`;
}
