# Approved mock conformance

An approved mock can be implemented differently while every existing test stays green. This registry binds each approved revision's behavioral requirements to the public E2E scenarios that must keep proving them.

`generic-instances-r1.json` starts the registry with the approved catalog instance journey. It reuses the existing browser and retained-pool scenarios. The remaining approved designs still need their requirements and missing scenarios added; this registry does not claim they conform.

When a mock is approved:

1. Add a JSON contract here with a stable ID, the approved artifact's name and SHA-256, and every accepted behavior. Keep private artifacts and personal data outside the public repository. Record changed approval requirements in a new revision.
2. Add or extend named scenarios in the carried `e2e/tests/` files. Drive the real server through HTTP or the browser. Exercise retained data and failure states where the requirement needs them. Put desktop and 390 px assertions in the same browser journey when both are approved. The scenario must assert the requirement; a checkpoint or source-text match is insufficient.
3. Register each scenario and target as `scheduled` in `e2e/test-plan.ts`. Map each requirement to that scenario, target and an existing required CI job. Give a new carry a coordinator-assigned number.
4. Make that job's literal `bun run e2e:<target> --test-name` selector include the scenario title. Keep it in the aggregate `check` dependencies and the heavy-job list. The architecture suite rejects missing declarations, implementations or CI selectors. It adds no second browser suite.

`npm run architecture:test -- mock-conformance.test.ts` tests the registry checker. The existing `fast` job runs its repository integration with the architecture suite; full main and batch checks run the declared behavioral jobs. A PR fast lane validates the wiring without claiming a browser result.

The checker verifies the proof is present and required, not whether an assertion captures the design correctly. Input review compares each requirement with the scenario's actual assertions and the approved artifact. Runtime E2E and deployed acceptance remain separate evidence.
