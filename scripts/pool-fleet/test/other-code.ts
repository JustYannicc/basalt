import { handleRuntimeHandoff } from "../../../src/pool/runtime-slots/http.ts";
import { runtimeHandoffCommandPrefix } from "../../../src/pool/runtime-slots/handoff-command.ts";
import { signEnvelope } from "../../../src/pool/token.ts";

const at = Date.now();
/** The code this lane's checkout signs for; the bridge below runs another. */
export const laneCode = { candidate: "c".repeat(40), workerInput: "d".repeat(64) };
export const otherCodeCommand = {
  action: "adopt",
  proof: "proof",
  controllerCode: laneCode,
  at,
  expiresAt: at + 60_000,
} as const;
const secret = "e".repeat(64);

/**
 * The real handoff bridge's answer to a command signed for other controller code than it runs, as
 * after a release before the controller hands over. It is whichever code refusal this checkout's
 * Worker writes, so a lane test built on it holds for the Worker the lane ships with.
 */
export async function otherCodeRefusal() {
  const handoff = { databasePool: () => null } as unknown as Parameters<
    typeof handleRuntimeHandoff
  >[1];
  return handleRuntimeHandoff(
    new Request("http://pool/handoff", {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(secret, runtimeHandoffCommandPrefix, otherCodeCommand),
      }),
    }),
    handoff,
    { candidate: "1".repeat(40), workerInput: "2".repeat(64) },
    secret,
  );
}
