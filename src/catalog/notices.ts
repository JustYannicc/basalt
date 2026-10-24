import { brand } from "../../brand.ts";

export interface ConnectionNotice {
  providerName: string;
  message: string;
}

const google = `${brand.name}'s Google connector is published but unverified. Google shows an unverified-app warning and limits this project to 100 users over its lifetime. Your Workspace admin may block access or mark the app trusted. You connect your own account and grant access only to the selected service.`;
const slack = `Connect your own Slack account through ${brand.name}. Messages post as you, with your access. Unlisted apps have conversation history and replies limited to 1 request per minute and 15 items per request. Your workspace may require admin approval.`;

/** Operator notices are feed data, never part of the tools API Worker. Provider names match the official apps. */
const configuredNotices: Readonly<Record<string, readonly ConnectionNotice[]>> = {
  "@executor.sh/gmail": [{ providerName: "Gmail", message: google }],
  "@executor.sh/google-calendar": [{ providerName: "Google Calendar", message: google }],
  "@executor.sh/google-drive": [{ providerName: "Google Drive", message: google }],
  "@executor.sh/google-docs": [{ providerName: "Google Docs", message: google }],
  "@executor.sh/google-sheets": [{ providerName: "Google Sheets", message: google }],
  "@executor.sh/google-slides": [{ providerName: "Google Slides", message: google }],
  "@executor.sh/github": [{ providerName: "GitHub", message: `Connect your own GitHub account through ${brand.name}. No app review is required. Organization approval and SAML single sign-on may limit which repositories you can reach.` }],
  "@executor.sh/zoho": [{ providerName: "Zoho CRM", message: `Connect your own Zoho CRM account through ${brand.name} and choose its data center. The app requests broad CRM access, including writes. CRM edition, API credits and administrator permissions still limit which tools your account can use. This connector does not include Zoho Mail, People or other Zoho products.` }],
  "@executor.sh/elevenlabs": [{ providerName: "ElevenLabs", message: `Connect your own ElevenLabs account with an API key through ${brand.name}'s secure connection form. No hosted OAuth client is available. The key must allow the current-user read check and each tool you use. This catalog app uses api.elevenlabs.io; regional residency API hosts are not supported.` }],
  "@executor.sh/slack": [{ providerName: "Slack", message: slack }],
};

export interface ConnectorAvailability {
  readonly google: boolean;
  readonly github: boolean;
  readonly zoho?: boolean;
  readonly atlassian?: boolean;
  readonly slack?: boolean;
}

/** Readiness is public feed data. Client credentials never reach this Worker. */
export function connectionNotices(ready: ConnectorAvailability): typeof configuredNotices {
  return Object.fromEntries(Object.entries(configuredNotices).map(([name, notices]) => {
    const unavailable = name === "@executor.sh/zoho" ? !ready.zoho
      : name === "@executor.sh/github" ? !ready.github
      : name === "@executor.sh/slack" ? !ready.slack
      : name !== "@executor.sh/elevenlabs" && !ready.google;
    return [name, unavailable ? notices.map(notice => ({ ...notice,
      message: `${notice.providerName} is not set up yet. ${notice.message}`,
    })) : notices];
  }));
}
