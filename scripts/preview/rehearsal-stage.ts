/**
 * STAGE-ONLY OVERLAY for heal B/C/D on test-rehearsal-N: never part of a production candidate.
 * Main knows only PR previews (#1560), so a candidate planned on a rehearsal stage would name the
 * production stack, zone and host. These are the rehearsal branch's names (`scripts/preview/
 * subject.ts` and `scripts/release-barrier/release-stage.ts` on #1306), reduced to what the stack
 * file reads, so the candidate plans the stack the stage has deployed.
 */
export const rehearsalStack = "basalt-rehearsal";
const rehearsalStage = /^test-rehearsal-[1-9][0-9]{0,9}$/u;

/** The Alchemy stack name for a stage. Previews and production keep the original name. */
export const stackNameForStage = (stage: string | undefined) =>
  stage !== undefined && rehearsalStage.test(stage) ? rehearsalStack : "basalt";

export interface DisposableStageNames {
  readonly slug: string;
  readonly sourceNamespace: string;
  readonly databaseName: string;
}

/**
 * A disposable stage's names, or undefined for a stage outside both prefixes. A malformed name
 * under either prefix throws, so the stack can never read it as production.
 */
export function disposableStageNames(stage: string): DisposableStageNames | undefined {
  if (!/^test-(?:pr|rehearsal)-/u.test(stage)) return undefined;
  const pr = /^test-pr-([1-9][0-9]*)$/u.exec(stage)?.[1];
  const slug =
    pr !== undefined && Number.isSafeInteger(Number(pr))
      ? `pr-${pr}`
      : rehearsalStage.test(stage)
        ? stage.slice("test-".length)
        : undefined;
  if (slug === undefined) throw new Error("Disposable stage name is malformed");
  return {
    slug,
    sourceNamespace: `basalt-preview-${slug}-apps`,
    databaseName: `basalt-preview-${slug}`,
  };
}
