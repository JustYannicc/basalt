/**
 * What a rehearsal stage owns by name. A rehearsal shares the account, the deploy token and the
 * container registry with production, and some of what it leaves (retained fleet applications,
 * pushed pool images) has no State row once its stacks are destroyed, so only the stage token in a
 * name places it. Kept free of imports: the entry reads it before it loads anything else.
 */
// One digit: the pool container's name is exactly Alchemy's 64-character limit at one, and from ten
// on Alchemy truncates it past the stage token, so nothing would find it by name.
const REHEARSAL_STAGE = /^test-rehearsal-[1-9]$/u;
export const rehearsalStack = "basalt-rehearsal";

export const isRehearsalStage = (stage: string) => REHEARSAL_STAGE.test(stage);

/**
 * Whether a container application or registry repository name is this rehearsal stage's, by its
 * whole shape, never a prefix: another stage's names may begin or end the same way.
 * - The fleet's applications, `basalt-<stage>-pool-runtime-<colour>` (src/pool/fleet-deployment.ts).
 * - Alchemy's container names under the rehearsal stack, `<stack>-<id>-<stage>-<16 base32>`, in
 *   lowercase (`createContainerApplicationName`). The id is one word, so no stage hides inside it.
 * A repository takes its application's name. The entry also refuses any stage that names
 * `rehearsal` without being exactly `test-rehearsal-<n>`.
 */
export function stageOwnsName(name: string, stage: string): boolean {
  if (!isRehearsalStage(stage)) return false;
  // The stage matched REHEARSAL_STAGE, so it holds no pattern characters.
  return (
    ["blue", "green"].some((colour) => name === `basalt-${stage}-pool-runtime-${colour}`) ||
    new RegExp(`^${rehearsalStack}-[a-z0-9]+-${stage}-[a-z2-7]{16}$`, "u").test(name)
  );
}
