# Pool access account identity

The pool's own `pool` provider has one `token` method. The host creates that
credential while provisioning the pool app. Declaring the method
`provisioned: true` hides account creation and credential replacement from the
dashboard, and makes the declaration part of the provider's content identity.

When a pool bundle job upgrades an existing app, the member job deploys the
bundle and then repairs the access link against the deployed requirements in
the same job. This mints a token for the new provider identity and links it
through the host-owned provisioned-link path. Existing apps left on an older
bundle keep their prior provider identity and link while their source is edited
or their active version differs from the recorded one. Token-only rotation
jobs continue to replace credentials on the currently deployed identity.

The proof lives in `scripts/upstream-tests/pool-provisioning.test.ts`. Its
fixtures check the deployment and link state together with the `Pool reconcile`
record, including `tokenRepaired`.
