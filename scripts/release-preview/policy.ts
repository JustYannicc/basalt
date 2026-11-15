/** Only the explicit release-preview entrypoint may bind a compiler acceptance release. */
export function compilerPreviewEnvironment(
  source: NodeJS.ProcessEnv,
  stage: string,
): NodeJS.ProcessEnv {
  const flag = source.EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE;
  if (!flag) return {};
  if (
    flag !== "true" ||
    source.GITHUB_ACTIONS !== "true" ||
    !/^test-pr-[1-9][0-9]*$/.test(stage) ||
    (source.ALCHEMY_STAGE !== undefined && source.ALCHEMY_STAGE !== stage) ||
    !/^[a-f0-9]{40}$/.test(source.BASALT_RELEASE_CANDIDATE ?? "")
  ) {
    throw new Error(
      "Compiler acceptance requires GitHub Actions, an exact release SHA and its test-pr stage",
    );
  }
  return {
    EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE: "true",
    BASALT_RELEASE_CANDIDATE: source.BASALT_RELEASE_CANDIDATE,
  };
}

export function requireCompilerPreviewIdentity(
  source: NodeJS.ProcessEnv,
  candidate: unknown,
  identity: { pullRequest: number; head: string },
): void {
  const environment = compilerPreviewEnvironment(source, `test-pr-${identity.pullRequest}`);
  const optedIn = environment.EXECUTOR_COMPILER_PREVIEW_ACCEPTANCE === "true";
  const marked =
    typeof candidate === "object" &&
    candidate !== null &&
    "compilerAcceptance" in candidate &&
    candidate.compilerAcceptance === true;
  if (optedIn !== marked || (optedIn && environment.BASALT_RELEASE_CANDIDATE !== identity.head)) {
    throw new Error("Compiler acceptance does not match the validated exact preview candidate");
  }
}
