import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { BarrierRefusal } from "./refusal.ts";
import { releaseTarget, type ReleaseTarget } from "./release-stage.ts";

/**
 * Production deploy jobs all hold the shared deploy-production Actions concurrency group. A
 * rehearsal is its own workflow and job with a lease named for its stage, so neither writer can
 * pass as the other.
 */
export function ordinaryReleaseWriter(env: NodeJS.ProcessEnv, now = Date.now) {
  const writerUnavailable = () =>
    new BarrierRefusal("runtime-release-exclusive-writer-unavailable", "PoolWorker");
  let target: ReleaseTarget;
  try {
    target = releaseTarget(env);
  } catch {
    throw writerUnavailable();
  }
  const workflows = target.rehearsal
    ? ["release-rehearsal.yml"]
    : ["deploy.yml", "release-main.yml", "release-manual.yml"];
  const candidate = env.BASALT_RELEASE_CANDIDATE ?? "";
  const repository = env.GITHUB_REPOSITORY;
  const ref = target.rehearsal ? (env.GITHUB_REF ?? "") : "refs/heads/main";
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== ref ||
    !/^refs\/(?:heads\/[A-Za-z0-9._/-]{1,200}|pull\/[1-9][0-9]*\/merge)$/u.test(ref) ||
    env.GITHUB_JOB !== (target.rehearsal ? "rehearsal" : "deploy") ||
    env.ALCHEMY_STAGE !== target.stage ||
    repository !== "JustYannicc/basalt" ||
    !workflows.some(
      (file) => env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${file}@${ref}`,
    ) ||
    !/^[a-f0-9]{40}$/u.test(candidate) ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw writerUnavailable();
  const group = target.rehearsal ? `release-rehearsal-${target.stage}` : "deploy-production";
  const lease = `${group}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`;
  const expiresAt = now() + 6 * 60 * 60 * 1_000;
  let queue: Promise<unknown> = Promise.resolve();
  const assert = () => {
    if (
      now() >= expiresAt ||
      env.BASALT_RELEASE_CANDIDATE !== candidate ||
      `${group}:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}` !== lease
    )
      throw new BarrierRefusal("runtime-release-writer-expired", "PoolWorker");
  };
  return {
    candidate,
    lease,
    assert,
    enable(manifest: string): ProvisioningEnable {
      assert();
      return { releaseWriter: { candidate, lease }, writerLease: lease, manifest, expiresAt };
    },
    exclusive<A>(work: () => Promise<A>): Promise<A> {
      const pending = queue.then(() => {
        assert();
        return work();
      });
      queue = pending.catch(() => {});
      return pending;
    },
  };
}
export type RuntimeReleaseWriter = ReturnType<typeof ordinaryReleaseWriter>;
