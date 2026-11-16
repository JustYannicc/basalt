import type { ProvisioningEnable } from "./provisioning-contract.ts";
import { BarrierRefusal } from "./refusal.ts";

/** These deploy jobs all hold the shared deploy-production Actions concurrency group. */
export function ordinaryReleaseWriter(env: NodeJS.ProcessEnv, now = Date.now) {
  const workflows = ["deploy.yml", "release-main.yml", "release-manual.yml"];
  const candidate = env.BASALT_RELEASE_CANDIDATE ?? "";
  const repository = env.GITHUB_REPOSITORY;
  if (
    env.GITHUB_ACTIONS !== "true" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_JOB !== "deploy" ||
    env.ALCHEMY_STAGE !== "production" ||
    repository !== "JustYannicc/basalt" ||
    !workflows.some(
      (file) =>
        env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/${file}@refs/heads/main`,
    ) ||
    !/^[a-f0-9]{40}$/u.test(candidate) ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    throw new BarrierRefusal("runtime-release-exclusive-writer-unavailable", "PoolWorker");
  const lease = `deploy-production:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`;
  const expiresAt = now() + 6 * 60 * 60 * 1_000;
  let queue: Promise<unknown> = Promise.resolve();
  const assert = () => {
    if (
      now() >= expiresAt ||
      env.BASALT_RELEASE_CANDIDATE !== candidate ||
      `deploy-production:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}` !== lease
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
