/**
 * What a rehearsal stage owns by name. A rehearsal shares the account, the deploy token and the
 * container registry with production, and some of what it leaves (retained fleet applications,
 * pushed pool images) has no State row once its stacks are destroyed, so only the stage token in a
 * name places it. Kept free of imports: the entry reads it before it loads anything else.
 */
const REHEARSAL_STAGE = /^test-rehearsal-[1-9][0-9]{0,9}$/u;
export const rehearsalStack = "basalt-rehearsal";

export const isRehearsalStage = (stage: string) => REHEARSAL_STAGE.test(stage);

/**
 * Whether a provider name is this rehearsal stage's: the fleet's `basalt-<stage>-` names, or
 * Alchemy's physical names under the rehearsal stacks that carry the stage whole, so
 * `test-rehearsal-2` never owns `test-rehearsal-20`. No other stage owns anything by name.
 */
export function stageOwnsName(name: string, stage: string): boolean {
  if (!isRehearsalStage(stage)) return false;
  // The stage matched REHEARSAL_STAGE, so it holds no pattern characters.
  const token = new RegExp(`(?:^|-)${stage}(?:-|$)`, "u");
  return (
    name.startsWith(`basalt-${stage}-`) ||
    (name.startsWith(`${rehearsalStack}-`) && token.test(name))
  );
}
