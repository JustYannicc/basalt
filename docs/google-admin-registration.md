# Google Admin registration packet

The official catalog already has the @executor.sh/google-admin app. It contains 139 tools for Google Workspace Directory, Reports, and Data Transfer operations. This packet registers the shared OAuth client for that app. It does not create another connector package.

## Google Cloud project and OAuth client

Use the existing personally controlled Google Cloud connector project. Keep it separate from the Signalbox sign-in project.

Enable the Admin SDK API, service name admin.googleapis.com. The app calls its Directory, Reports, and Data Transfer endpoints. Its account health check reads https://openidconnect.googleapis.com/v1/userinfo.

Create or open the OAuth client ID with application type Web application. Register these exact origins:

- Authorized JavaScript origin: https://app.signalbox.run
- Authorized redirect URI: https://app.signalbox.run/api/oauth/callback

Use the Google OAuth endpoints from the current OIDC metadata:

- Authorization endpoint: https://accounts.google.com/o/oauth2/v2/auth
- Token endpoint: https://oauth2.googleapis.com/token
- Token endpoint client authentication: client_secret_post
- Authorization parameters: access_type=offline and prompt=consent

## OAuth consent scopes

Add the identity scopes that the account health check uses:

- openid
- email
- profile

Add these 18 Admin SDK scopes for the Google Admin app:

- https://www.googleapis.com/auth/admin.directory.user
- https://www.googleapis.com/auth/admin.directory.user.alias
- https://www.googleapis.com/auth/admin.directory.user.security
- https://www.googleapis.com/auth/admin.directory.userschema
- https://www.googleapis.com/auth/admin.directory.group
- https://www.googleapis.com/auth/admin.directory.group.member
- https://www.googleapis.com/auth/admin.directory.orgunit
- https://www.googleapis.com/auth/admin.directory.domain
- https://www.googleapis.com/auth/admin.directory.customer
- https://www.googleapis.com/auth/admin.directory.rolemanagement
- https://www.googleapis.com/auth/admin.directory.device.chromeos
- https://www.googleapis.com/auth/admin.directory.device.mobile
- https://www.googleapis.com/auth/admin.directory.device.mobile.action
- https://www.googleapis.com/auth/admin.directory.resource.calendar
- https://www.googleapis.com/auth/admin.chrome.printers
- https://www.googleapis.com/auth/admin.reports.audit.readonly
- https://www.googleapis.com/auth/admin.reports.usage.readonly
- https://www.googleapis.com/auth/admin.datatransfer

Do not add these Admin scopes to ordinary Google consent requests. The shared Google client keeps identity-only defaults. Its allowlist includes the Admin scopes so the separate Google Admin app can request them. The existing Google app continues to request only its own declared scopes. Its People API scope directory.readonly is separate from Admin SDK scopes.

## Audience and Workspace policy

Set the audience to External so people outside the developer project can authorize the app. Complete the branding, production publishing, and OAuth verification steps Google currently requires for these scopes. Confirm the audience and review status in Google Cloud Console before unrelated Workspace users connect. The catalog source does not prove current project status or API availability.

A Google Workspace administrator with the required privileges must authorize the app. A consumer Google account cannot administer a Workspace. A customer may also restrict third-party apps through Admin console API controls. Domain-wide delegation is not the default for this client.

Google assigns scope review requirements in its current console. Confirm any required verification or independent security assessment there. This packet does not establish review completion, assessment cost, or registration cost.

## Runtime settings

Store the shared client ID and secret in the existing optional settings EXECUTOR_OAUTH_GOOGLE_CLIENT_ID and EXECUTOR_OAUTH_GOOGLE_CLIENT_SECRET. Keep the secret in private host configuration.

The client remains optional. A person can keep using their own OAuth client through the existing BYO flow.

## Sources

- [Google OIDC discovery metadata](https://accounts.google.com/.well-known/openid-configuration)
- [Admin SDK Directory API authorization](https://developers.google.com/workspace/admin/directory/v1/guides/authorizing)
- [Workspace app access controls](https://support.google.com/a/answer/7281227)
- [OAuth production readiness](https://developers.google.com/identity/protocols/oauth2/production-readiness)
