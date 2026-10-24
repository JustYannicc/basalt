# Zoho native proof

This proof runs the pinned public self-host runtime in the .upstream checkout. It deploys the official Zoho CRM app snapshot at:

the file named by the ZOHO_SNAPSHOT_PATH environment variable

The snapshot hash is pinned to 3d9311639b4a1004e68e73d001c1d238aa2e420dc030173f706de65f75adbdb2. The runner reads it without writing or copying it into Git.

## Local adaptations

The runner changes only the deployed in-memory payload:

- It replaces the eight account server origins and eight CRM API origins in openapi.ts with one 127.0.0.1 fixture origin.
- It replaces the OpenAPI server origin in document.json with that fixture origin and /crm/v8.
- It changes the apps dependency in package.json from 0.0.1-beta.100 to the version staged by the pinned .upstream E2E runtime.

The record stores the original snapshot hash, each original file hash, each deployed file hash, and the full deployment payload hash. It also records the single regional OAuth test definition cloned from the hosted EU client. That test definition uses synthetic client credentials and the same loopback fixture origin.

## Scenario

The public self-host sign-up and invitation APIs create one organization with a member and an admin. Both actors connect different synthetic Zoho CRM accounts through the normal OAuth flow. The test checks that each account health request reaches /crm/v8/org with the Zoho-oauthtoken scheme.

Each actor then uses the public MCP endpoint with the pinned MCP SDK. The test searches for the Zoho app, describes the official getRecords tool, and reads the Leads module. Each response must contain the caller's marker and omit the peer's marker. A call that selects the peer account must fail before any CRM fixture request. The hosted account read and app-link requests must also return 403 or 404.

getRecords is a read-only CRM operation. The fixture stores only request method, path, actor label, authorization scheme, status, and safe query fields. It never stores tokens, codes, request bodies, or successful MCP payloads.

## Run

Prepare the normal upstream E2E artifacts from the Zoho worktree:

heavy-slot bun run e2e:prepare

Then run the proof preflight and native proof from the repository root:

node scripts/check-zoho.ts --preflight

node scripts/check-zoho.ts

The proof wrapper runs the native scenario under heavy-slot. The first failure record is kept in the run directory. Do not retry the same candidate and scenario without changing the candidate or operating inputs.

Each run writes an invocation plan before starting the product runtime. It writes a second exact MCP invocation before connecting the native MCP clients. The immutable record.json includes source pins, runtime and patch digests, snapshot and payload hashes, fixture requests, outcome, and hashes for every evidence file.

The proof covers local synthetic OAuth and CRM responses. It does not prove Zoho production consent, production CRM access, or live regional routing.
