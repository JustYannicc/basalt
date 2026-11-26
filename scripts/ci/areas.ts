const accounts = [
  "host-managed-accounts",
  "host-managed-accounts-adopted",
  "host-managed-accounts-pool",
  "host-managed-accounts-pool-actions",
  "host-managed-accounts-local",
  "host-managed-accounts-cloud",
  "host-managed-accounts-cloud-actions",
  "host-managed-accounts-runtime",
  "oauth-account-regressions",
  "pool-account-recovery",
  "contributed-accounts",
  "account-acquisition",
  "account-observations",
  "account-usage",
  "personal-data-reporting",
  "client-native-product",
  "google-account-recovery",
  "google-account-diagnostics",
  "contributed-account-recipes",
  "catalog-compat",
  "dashboard-batch",
  "pool-inventory",
  "slack-health",
  "gitlab-connectors",
  "workos-sign-in",
  "gitlab-sign-in",
  "clerk-sign-in",
  "planetscale-sign-in",
  "vercel-sign-in",
  "elevenlabs-sign-in",
  "neon-key-reuse",
  "mcp-apps",
  "production-ops",
  "production-ops-migrations",
  "production-ops-atlassian-adoption",
  "production-ops-identity",
  "production-build",
];
const operations = [
  "production-ops",
  "production-ops-migrations",
  "production-ops-atlassian-adoption",
  "production-ops-identity",
];

export const heavyJobs = [
  "client-mobile",
  "client-desktop",
  "client-native-product",
  "slack-health",
  "host-managed-accounts",
  "host-managed-accounts-adopted",
  "host-managed-accounts-pool",
  "host-managed-accounts-pool-actions",
  "host-managed-accounts-local",
  "host-managed-accounts-cloud",
  "host-managed-accounts-cloud-actions",
  "host-managed-accounts-runtime",
  "oauth-account-regressions",
  "pool-account-recovery",
  "google-account-recovery",
  "google-account-diagnostics",
  "sso-service-binding",
  ...operations,
  "compiler-diagnostics",
  "human-in-the-loop",
  "human-in-the-loop-navigation",
  "human-in-the-loop-cloud",
  "access-editor-reads",
  "contributed-accounts",
  "personal-data-reporting",
  "contributed-account-recipes",
  "catalog-compat",
  "pool-inventory",
  "dashboard-batch",
  "aws-connectors",
  "gitlab-connectors",
  "workos-sign-in",
  "gitlab-sign-in",
  "clerk-sign-in",
  "planetscale-sign-in",
  "vercel-sign-in",
  "elevenlabs-sign-in",
  "neon-key-reuse",
  "mcp-apps",
  "account-acquisition",
  "account-observations",
  "account-usage",
  "pool-runtime",
  "upstream-image",
  "production-build",
  "declared-self-host",
  "declared-local",
  "declared-cloud",
  "docs-build",
  "upstream-contracts",
];

// Shared infrastructure changes need every consumer. Feature rules below may overlap deliberately.
export const sharedInputs = [
  ".upstream/packages/ui/src/implementation/dashboard/{app-detail,publish-app}.tsx",
  // Helpers and fixture assets may have consumers outside any one declaration.
  ".upstream/e2e/support/**",
  ".upstream/e2e/fixtures/**",
  "upstream.json",
  "brand.ts",
  "alchemy.run.ts",
  "package.json",
  "tsconfig*.json",
  // Workflow files, as the Check workflow's triggers, concurrency, permissions, env and defaults
  // apply to every job. A change inside one Check job's block arrives as that job's input
  // instead (workflowInputs in affected.ts); the scripts that select and gate jobs are
  // selectionInputs below.
  ".github/workflows/**",
  // Selection parses the workflow and the import graph with this package's pinned tooling.
  "scripts/architecture/{package.json,bun.lock}",
  // Unlike the Check's job blocks and the scripts that select and gate jobs, every job executes
  // these: the setup actions' downloads and preparation, with the declared e2e plans it writes.
  // A change to one changes what every job runs, so it runs every job.
  "scripts/ci/{setup-node.mjs,setup-bun.ts,verified-download.mjs,deny-release-downloads.cjs}",
  "scripts/ci/{node,bun}-assets.json",
  "scripts/ci/{prepare-e2e,dependency-lifecycles,declarations}.ts",
  "scripts/ci/{e2e-groups,inherited-tests,upstream-files}.json",
  "scripts/prepare-upstream.ts",
  "scripts/upstream-cache.ts",
  "scripts/upstream-carries.ts",
  "scripts/pool-test-runtime/**",
  "scripts/process.ts",
  "scripts/failure/{child,process-tee,redact}.ts",
  "scripts/releases/patches.json",
  ".upstream/package.json",
  ".upstream/bun.lock",
  ".upstream/tsconfig*.json",
  ".upstream/patches/**",
  ".upstream/e2e/sdk/**",
  ".upstream/e2e/setup.ts",
  ".upstream/e2e/run.ts",
  ".upstream/e2e/vitest.config.ts",
  ".upstream/e2e/support/{api,actors,case,lifecycle,managed-cloud,managed-server,platform,ports,cloud-listener}.ts",
  ".upstream/packages/{utils,app-data,app-cache,apps,sdk}/**",
  ".upstream/apps/{hosted,local}/server/**",
  ".upstream/apps/hosted/cloud/src/**",
  ".upstream/**/{auth,storage,db,protocol,contracts}/**",
  ".upstream/**/platform.ts",
  "src/router.ts",
  "src/browser-check.ts",
];

export const areas = [
  {
    paths: ["e2e/browser-fixture-certificate-trust.test.ts"],
    jobs: ["planetscale-sign-in"],
  },
  {
    paths: ["e2e/workos-sign-in.mjs", "e2e/management-signin/**"],
    jobs: ["workos-sign-in", "clerk-sign-in"],
  },
  { paths: ["e2e/clerk-sign-in.mjs", "e2e/clerk-signin/**"], jobs: ["clerk-sign-in"] },
  { paths: ["e2e/gitlab-sign-in.mjs", "e2e/gitlab-signin/**"], jobs: ["gitlab-sign-in"] },
  {
    paths: [
      "e2e/neon-key-reuse.mjs",
      "e2e/neon-fixture.mjs",
      "e2e/openapi-fixture.mjs",
      "src/catalog/neon*",
    ],
    jobs: ["neon-key-reuse"],
  },
  {
    paths: [
      "e2e/planetscale-sign-in.mjs",
      "e2e/planetscale-signin/**",
      "src/catalog/planetscale*",
      ".upstream/apps/hosted/server/src/implementation/planetscale-oauth.ts",
    ],
    jobs: ["planetscale-sign-in"],
  },
  {
    paths: ["clients/obsidian/**", "src/drive/**", "apps/obsidian/**", "e2e/obsidian/**"],
    jobs: ["production-build"],
  },
  { paths: ["clients/**"], jobs: ["client-mobile", "client-desktop", "client-native-product"] },
  {
    paths: ["src/tunnel/**", "e2e/native-*", ".upstream/**/{client-grants,device-authorization}*"],
    jobs: ["client-native-product", "production-build"],
  },
  {
    // Pool data its code and proofs read at runtime. Pool code reaches its jobs through the import
    // graph, and the e2e product's reads of it are declared in productReads below.
    paths: [
      "src/pool/**/*.{json,txt}",
      "apps/pool/**/*.{json,html,css}",
      "scripts/pool-*/**/*.{json,lock,py}",
    ],
    jobs: [...accounts, "pool-runtime", "pool-inventory", "upstream-contracts"],
  },
  // Only pool-runtime and its pool proofs build the pool image.
  { paths: ["containers/pool/**"], jobs: ["pool-runtime"] },
  {
    paths: ["src/catalog/**", "recipes/**", "scripts/connectors*/**/*.{json,lock}"],
    jobs: accounts,
  },
  {
    paths: ["e2e/zoho-people*.mjs"],
    jobs: ["catalog-compat"],
  },
  {
    paths: ["src/catalog/slack.json", "e2e/slack*/**", "e2e/slack*.mjs", ".upstream/**/slack*/**"],
    jobs: ["slack-health"],
  },
  {
    paths: [
      "e2e/oauth-renewal-recovery.mjs",
      "e2e/oauth-renewal-recovery/**",
      ".upstream/packages/sdk/src/contracts/oauth-failure-evidence.ts",
      ".upstream/packages/ui/src/contracts/account-check-recovery.ts",
    ],
    jobs: ["oauth-account-regressions"],
  },
  {
    paths: [
      "src/catalog/aws*",
      "src/catalog/aws*/**",
      "src/catalog/{worker,feed,settings,oauth-policy}.ts",
      "e2e/aws/**",
      "scripts/check-aws.ts",
      ".upstream/apps/hosted/web/src/implementation/pages/{app-accounts-client,connect-account,loopback-oauth}.tsx",
    ],
    jobs: ["aws-connectors"],
  },
  {
    paths: ["src/catalog/gitlab.json", "scripts/gitlab*/**", ".upstream/**/gitlab*/**"],
    jobs: ["gitlab-connectors"],
  },
  {
    // The Workers the stack deploys, which production-build bundles and measures from their entries.
    paths: [
      "alchemy.run.ts",
      "infrastructure/**",
      "src/*.ts",
      "src/catalog/**",
      "src/setup/**",
      "src/site/**",
      "src/feedback/**",
      "src/telemetry/**",
      "src/pool/**",
      "apps/pool/**",
      "assets/**",
      "clients/contracts/**",
    ],
    jobs: ["production-build"],
  },
  {
    paths: [
      ".upstream/**/*account*",
      ".upstream/**/*account*/**",
      ".upstream/**/*oauth*",
      ".upstream/**/*oauth*/**",
      ".upstream/**/*consent*",
      ".upstream/**/*invitation*",
      ".upstream/**/*sharing*",
      ".upstream/**/*pool*",
      ".upstream/**/*pool*/**",
    ],
    jobs: accounts,
  },
  {
    paths: [
      "scripts/production-ops/**",
      ".upstream/**/*production-ops*",
      ".upstream/**/*production-ops*/**",
      ".upstream/**/*provider-adoption*",
    ],
    jobs: operations,
  },
  {
    paths: [".upstream/**/*sso*", ".upstream/**/*saml*", ".upstream/**/*oidc*"],
    jobs: ["sso-service-binding", "production-ops"],
  },
  {
    paths: [".upstream/**/*compiler*", ".upstream/**/*app-build*"],
    jobs: ["compiler-diagnostics", "mcp-apps"],
  },
  {
    paths: [".upstream/**/*approval*", ".upstream/**/*workflow*", ".upstream/**/*workflow*/**"],
    jobs: ["human-in-the-loop", "human-in-the-loop-navigation", "human-in-the-loop-cloud"],
  },
  {
    paths: [
      ".upstream/apps/hosted/web/src/implementation/pages/{resource-settings,app-detail,account-actions}.tsx",
      ".upstream/e2e/tests/access-editor-reads.spec.ts",
      ".upstream/e2e/support/read-dispatch.ts",
      ".upstream/e2e/tests/member-controls.spec.ts",
      ".upstream/e2e/tests/publishing-off.spec.ts",
    ],
    jobs: ["access-editor-reads"],
  },
  {
    paths: [
      ".upstream/**/*dashboard*",
      ".upstream/**/*batch*",
      ".upstream/**/*prefetch*",
      ".upstream/e2e/tests/cached-account-controls.spec.ts",
      ".upstream/e2e/tests/cached-provider-policy.spec.ts",
      ".upstream/apps/hosted/web/src/implementation/pages/{app-accounts-client,connection-dialog}.tsx",
      ".upstream/e2e/tests/first-entry-*.spec.ts",
      ".upstream/e2e/tests/hidden-section-reads.spec.ts",
      ".upstream/e2e/support/first-entry-reveal-probe.ts",
      ".upstream/apps/hosted/{self-host,cloud}/web/src/implementation/routes/*.{accounts,approvals}.index.tsx",
      ".upstream/apps/hosted/web/src/implementation/pages/{accounts,approvals}.tsx",
      ".upstream/packages/ui/src/implementation/dashboard/{accounts,review-lazy}.tsx",
      ".upstream/**/*route*",
      ".upstream/**/*loading*",
    ],
    jobs: [
      "dashboard-batch",
      "human-in-the-loop",
      "human-in-the-loop-navigation",
      "human-in-the-loop-cloud",
    ],
  },
  {
    paths: [".upstream/**/*mcp-app*", ".upstream/packages/{apps,sdk}/**"],
    jobs: [
      "mcp-apps",
      ...accounts,
      "human-in-the-loop",
      "human-in-the-loop-navigation",
      "human-in-the-loop-cloud",
      ...operations,
    ],
  },
  { paths: [".upstream/**/*migration*", ".upstream/**/*migration*/**"], jobs: heavyJobs },
  {
    paths: [
      ".upstream/apps/{hosted,local}/**",
      ".upstream/packages/{apps,sdk,mcp,mcp-auth}/**",
      ".upstream/packages/{ui,workflow-graph}/**",
      "scripts/*build*",
      "scripts/worker-*/**",
    ],
    jobs: ["production-build"],
  },
  {
    paths: ["assets/fonts/**", "scripts/docs-fonts/**", ".upstream/apps/docs/**"],
    jobs: ["docs-build"],
  },
  // `select` plans every declared shard's rows and timeout from the measured durations.
  {
    paths: ["scripts/ci/declared-durations.json"],
    jobs: heavyJobs.filter((job) => job.startsWith("declared-")),
  },
];

/**
 * Reads by computed paths that the import graph cannot follow, declared as edges from the file
 * that reads them: preparation bundles the whole pool app into the e2e product, the pool
 * runtime shards list their test files by directory, the Cloudflare family fixture loads its
 * catalog sources by name, and the Home peer program bundles the peer modules the pool Worker
 * build checks. Preparation also writes a hash of the pool Worker's sources into the product,
 * but e2e compares it only with the same generated value, so those sources reach no scenario
 * through it.
 */
export const runtimeReads = [
  { reader: "scripts/pool-app-bundle.ts", paths: ["apps/pool/**"] },
  { reader: "scripts/ci/pool-test-shard.ts", paths: ["scripts/pool-tests/*.test.ts"] },
  {
    reader: "scripts/upstream-tests/cloudflare-family-fixture.ts",
    paths: ["src/catalog/cloudflare.json", "src/catalog/cloudflare.published.json"],
  },
  { reader: "scripts/pool-peer-program.ts", paths: ["containers/pool/home_peer*.py"] },
];

/**
 * The scripts that select, route, gate and report on the Check's jobs, and their data. They run
 * in `select`, `fast`, `check`, `box-watch`, the re-run workflows or locally, and `fast` runs
 * their tests (scripts/ci*.test.ts, through the owned unit suite) and actionlint in every Check,
 * so a change to them runs no heavy job. Heavy jobs touch one corner of them: preparation checks
 * declarations against `areas.ts` and `inputs.ts`, which `fast`'s preparation also runs on the
 * same tree. The declared jobs' shard planner, `shards.ts`, and its measured durations are not
 * listed: each declared shard runs with the rows, timeout and per-file deadline they plan, so
 * they reach the declared jobs. What a change to one breaks beyond `fast` meets the batch Check,
 * which runs every heavy job.
 */
export const selectionInputs = [
  "scripts/ci/{affected,areas,reach,import-graph,job-inputs,inputs,e2e-workflow}.ts",
  "scripts/ci/{select-jobs,unit-tests,box-router,box-watch,box-rerun,light-lane,light-rescue}.ts",
  "scripts/ci/{cancel-superseded,reuse,gate,aggregate-retries,retry-history,workflow-run}.ts",
  "scripts/ci/{retries,fast-local,rerun-selection}.ts",
  "scripts/ci/e2e-exceptions.json",
];

export const staticInputs = [
  "architecture/**/*.c4",
  "architecture/**/*.md",
  "docs/**/*.md",
  "README.md",
  "scripts/ci/README.md",
  "LICENSE",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ".github/pull_request_template.md",
  ".gitignore",
];
