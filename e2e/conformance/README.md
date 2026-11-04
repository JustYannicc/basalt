# Approved mock conformance

This registry binds approved design obligations to required public E2E scenarios. A green wiring check does not establish that a whole mock conforms or that a deployed screen matches it.

Each requirement has either `proofs` or an explicit `gap` with `state: "open"`, an owner and a reason. An open gap cannot carry claimed proofs. Close it by adding relevant behavioral assertions and replacing the gap with their scenario bindings. Do not remove an accepted obligation to make the registry green.

| Approved revision               | Existing proof bindings                               | Explicitly uncovered behavior                                                                                                                                                                                  |
| ------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic instances r1            | `catalogInstances`, `poolCreation`                    | No known gap in the registered obligations.                                                                                                                                                                    |
| Google one account              | `accountIdentityRows`, `accountIdentityConsentScreen` | Retained hosted grants, missing verification metadata and recovery without repeated reconnects.                                                                                                                |
| PR7 provider accounts and pools | `accountFamilyPools`                                  | Pool selection UI, unavailable-lab disclosure, retained adoption and the later accepted select-only delta.                                                                                                     |
| Compact rows r3                 | `accountCompactRows`                                  | App-account identity/Add app usability, full columns and usage cells, reset confirmation and credit choice, touch-accessible expiry, health history, retained Google recovery and no automatic reset spending. |
| Setup v2 with accepted deltas   | `poolSetupConnect`, `poolKeysConnect`                 | The complete preserved assistant/method set, expired-link presentation and the accepted Claude Desktop one-click primary flow.                                                                                 |
| Overview r2                     | None                                                  | All five registered obligations are open, owned by the history/overview owner of PR #384. Older native Settings charts do not prove this overview.                                                             |

Artifact names are public identifiers for the original HTML bytes whose SHA-256 is recorded. Private mock files stay outside the repository. Setup v2 pins its Claude Code screen as the approval anchor. `approvalDeltas` records the accepted changes to the original artifact; unapproved setup v3 is not substituted for v2, and the later pool select-only decision is not attributed to the original PR7 footer.

When a mock is approved:

1. Add a JSON contract with a stable ID, approved artifact name and SHA-256, and every accepted behavior. Bind supported obligations separately from missing proof. Record approval changes explicitly.
2. Add or extend named scenarios in the carried `e2e/tests/` files. Drive the real server through HTTP or the browser. Exercise retained data, failure states and desktop/390 px behavior where required. Assertions must establish the obligation; screenshots alone are insufficient.
3. Schedule each proof's target in `e2e/test-plan.ts`, then bind the scenario, target and an existing required CI job. New carries need a coordinator-assigned number.
4. Include the title in that job's literal `bun run e2e:<target> --test-name` selector and retain its aggregate dependency. The checker requires the unconditional, failure-propagating `node scripts/ci/gate.ts` invocation and its exact inputs.

The static checker accepts direct module registrations and synchronous `describe` or `layer(...)(...)` suite callbacks. Test calls accept exactly two arguments or a literal numeric timeout as the third; options objects and computed options do not establish execution. Suites accept exactly their title and synchronous callback. Skipped or modified suites, conditional or deferred registrations and unsupported wrappers do not establish execution. Supporting another registration structure requires an explicit verifier rather than arbitrary AST traversal.

`npm run architecture:test -- mock-conformance.test.ts` validates the registry and reports open gaps as `OPEN acceptance gap`. The existing fast job checks this wiring; full main/batch jobs run the registered scenarios. Registry-only paths currently select the existing full suite through the unknown-path fallback. No second browser suite is added.

Input review compares each obligation with actual assertions and the approved artifact. Runtime E2E execution and deployed acceptance remain separate evidence. A matching registration with an irrelevant or empty callback still fails that semantic review.
