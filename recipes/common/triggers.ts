import type { MutationContext } from "apps";
import { requirements } from "./installation.ts";
export async function startTick(
  ctx: MutationContext<typeof requirements>,
  workflow: string,
  target: string,
  periodMs: number,
) {
  const tick = Math.floor(Date.now() / periodMs);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${workflow}:${target}:${tick}`),
  );
  const key = `check:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return ctx.workflows.start({ workflow, key, input: { target, tick } });
}
