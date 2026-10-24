import { brand } from "../../brand.ts";

export interface ConnectionNotice {
  providerName: string;
  message: string;
}

const google = `${brand.name}'s Google connector is published but unverified. Google shows an unverified-app warning and limits this project to 100 users over its lifetime. Your Workspace admin may block access or mark the app trusted. You connect your own account and grant access only to the selected service.`;
const slack = `Slack is not one-click yet. The catalog app's OAuth flow returns a bot token, so ${brand.name} cannot use it for your personal connection. A personal user-token flow is still needed. Unlisted apps also have conversation history and replies limited to 1 request per minute and 15 items per request. Your workspace may require admin approval.`;

/** Operator notices are feed data, never part of the tools API Worker. Provider names match the official apps. */
const configuredNotices: Readonly<Record<string, readonly ConnectionNotice[]>> = {
  "@executor.sh/gmail": [{ providerName: "Gmail", message: google }],
  "@executor.sh/google-calendar": [{ providerName: "Google Calendar", message: google }],
  "@executor.sh/google-drive": [{ providerName: "Google Drive", message: google }],
  "@executor.sh/google-docs": [{ providerName: "Google Docs", message: google }],
  "@executor.sh/google-sheets": [{ providerName: "Google Sheets", message: google }],
  "@executor.sh/google-slides": [{ providerName: "Google Slides", message: google }],
  "@executor.sh/github": [{ providerName: "GitHub", message: `Connect your own GitHub account through ${brand.name}. No app review is required. Organization approval and SAML single sign-on may limit which repositories you can reach.` }],
  "@executor.sh/slack": [{ providerName: "Slack", message: slack }],
};

export interface ConnectorAvailability {
  readonly google: boolean;
  readonly github: boolean;
}

/** Readiness is public feed data. Client credentials never reach this Worker. */
export function connectionNotices(ready: ConnectorAvailability): typeof configuredNotices {
  return Object.fromEntries(Object.entries(configuredNotices).map(([name, notices]) => {
    const unavailable = name === "@executor.sh/github" ? !ready.github
      : name !== "@executor.sh/slack" && !ready.google;
    return [name, unavailable ? notices.map(notice => ({ ...notice,
      message: `${notice.providerName} is not set up yet. ${notice.message}`,
    })) : notices];
  }));
}
