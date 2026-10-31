# Google connector readiness

Checked 2026-10-30 against the public all-in-one `@executor.sh/google` catalog source and the pinned host at `f69c667936e4c02c75f9d7cc79fb750c230839b9`.

## Current state

The setup observation at 15:15 UTC on October 25 recorded External Testing with a listed test user and six APIs enabled. A later connector-registration update on October 30 says the six requested APIs are off and legal API terms approval is still pending before enablement. Treat the later status as current. Once the terms gate is cleared, only listed test users can connect while the app stays in Testing; their data-access grants and refresh tokens expire after seven days. See [Google's Testing rules](https://support.google.com/cloud/answer/15549945) and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

Publishing, verification and the applicable CASA assessment remain operator decisions. This check made no provider changes and ran no live consent or feature tests.

## All-in-one scope eligibility

The captured [catalog source](https://catalog.executor.sh/apps/google.json) has SHA-256 `20e334184f950d69cafbf91e13b3cbb2d2f68b5349edbbfa3b3b9032573d2f04`. It declares 23 scopes: identity scopes plus Gmail, Calendar, Drive, Sheets, Docs, Slides, Forms, Tasks, People, Meet, Photos Library and Photos Picker access.

All 23 scopes match the pinned host's [Google allowlist](https://github.com/UsefulSoftwareCo/executor/blob/f69c667936e4c02c75f9d7cc79fb750c230839b9/apps/hosted/server/src/implementation/first-party-oauth.ts#L28-L63). Google's [discovery document](https://accounts.google.com/.well-known/openid-configuration) supplies authorization and token endpoints matching that hosted client. The combined app therefore does not require BYO credentials because of a scope mismatch. This establishes source eligibility, not live client configuration or provider approval.

## Additional API enablement

Beyond the six requested APIs, the combined app calls six more services. Their enablement in the connector project remains unverified.

| API | Service ID | Requested scope suffixes |
| --- | --- | --- |
| Forms | `forms.googleapis.com` | `forms.body`, `forms.responses.readonly` |
| Tasks | `tasks.googleapis.com` | `tasks` |
| People | `people.googleapis.com` | `contacts`, `contacts.other.readonly`, `directory.readonly` |
| Meet REST | `meet.googleapis.com` | `meetings.space.created`, `meetings.space.readonly`, `meetings.space.settings` |
| Photos Library | `photoslibrary.googleapis.com` | `photoslibrary.appendonly`, `photoslibrary.readonly.appcreateddata`, `photoslibrary.edit.appcreateddata` |
| Photos Picker | `photospicker.googleapis.com` | `photospicker.mediaitems.readonly` |

Scope suffixes use `https://www.googleapis.com/auth/`. Check these six additional service states before claiming full all-in-one readiness. [Google API enablement guide](https://developers.google.com/workspace/guides/enable-apis).

`directory.readonly` belongs to the People API, not Admin SDK. The app has no Admin SDK route or `admin.directory.*` scopes. Directory results also depend on Workspace sharing policy. See [People API](https://developers.google.com/people) and [Google OAuth scopes](https://developers.google.com/identity/protocols/oauth2/scopes).

## Provider acceptance

Full Gmail and Drive access includes restricted scopes. Public production use needs the applicable verification, and server access to restricted data can require CASA. These remain unproven. See [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).

Photos Library reads and edits cover app-created media. Picker lets users select existing photos. These limits and the additional verification requirements follow [Google's Photos API changes](https://developers.google.com/photos/support/updates) and [authorization guidance](https://developers.google.com/photos/overview/authorization).
