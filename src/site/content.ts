import { brand } from "../../brand.ts";

/**
 * The public site's copy. Blocks are headings, paragraphs and lists; inline text may hold
 * `**bold**` and `[label](href)`, which the renderer escapes and expands, and nothing else.
 */
export type Block =
  | { readonly h2: string }
  | { readonly p: string }
  | { readonly ul: readonly string[] }
  /** Short lines kept together, such as an address. */
  | { readonly lines: readonly string[] };

export interface LegalPage {
  readonly path: string;
  /** Its name in the footer. */
  readonly label: string;
  readonly title: string;
  readonly summary: string;
  readonly blocks: readonly Block[];
}

const { name, site } = brand;
const email = `[${site.email}](mailto:${site.email})`;
const operator = `${site.operator}, ${site.region}`;

/**
 * The home page says what we are building, the way a manifesto would. What the app does with
 * Google data stays one quiet line under it, which Google's review requires.
 */
export const home = {
  /** Two lines, the second set in italic. */
  headline: ["Put the work", "at the center."],
  subheadline: "AI still works the way Office did.",
  body: [
    "Today everything starts with you: your laptop, your apps, your files, your agents. You carry the work between them, and AI helps one task at a time. Office worked like that, until Drive put the document at the center and let everyone come to it.",
    `${name} does that for work with AI. The work lives in one place, and the people and agents on it gather around it. Agents do the work and come to you only when they need you. We're building one place for everything you do with AI: simple enough to start in a minute, with no ceiling.`,
  ],
  tagline: "The work comes first.",
  action: { label: "Sign in", href: `https://${brand.host}` },
  note: `${name} connects your agents to Gmail, Calendar and Drive with your own Google sign-in, so they can work in them for you.`,
} as const;

const privacy: LegalPage = {
  path: "/privacy",
  label: "Privacy",
  title: "Privacy Policy",
  summary: `What ${name} stores, where, who else receives it, and what you can do about it.`,
  blocks: [
    {
      p: `${name} (${brand.zone} and ${brand.host}) is operated by ${operator} ("we"). Questions: ${email}.`,
    },
    { h2: "What we store" },
    {
      p: "**Your account.** Your name, email address and profile picture (if you sign in with Google or GitHub), your passkeys, and your organizations, members and invitations. For each signed-in session we store the IP address and browser it came from. Sign-in codes are stored only as hashes and expire after 5 minutes. Invitations expire after 7 days.",
    },
    {
      p: "**Connected accounts.** When you connect a service such as Google, GitHub, Slack, Atlassian, GitLab, Miro, Zoho CRM or Zendesk, we store the access and refresh tokens that service gives us. For services that use keys, such as AWS or ElevenLabs, we store the keys you enter. They are encrypted (AES-256-GCM) before they are stored and used only to make the requests you or your agents ask for.",
    },
    {
      p: "**Apps and their data.** Apps you install can store their own data. Workflows keep their inputs, results and each step's output, encrypted. Events apps send each other are stored encrypted for 3 days.",
    },
    {
      p: "**Model subscriptions.** If you connect a model subscription to your pool, its credentials are held by the pool backend, which runs in the EU. We keep daily usage counts per person, provider and model (requests, tokens and cost) for 30 days. Your model requests and responses pass through the pool backend to your provider. The pool backend doesn't keep the content of requests that succeed. To continue some conversations across providers, it can store parts of a response, such as tool-call details, in the pool database for about an hour.",
    },
    {
      p: "When a request fails, the pool backend currently keeps the provider's error response, which can include content, together with the key that made the request. We are removing these copies.",
    },
    {
      p: "**Feedback.** If you or your agent send feedback, we receive the message, the page you were on, recent error codes and any screenshot you choose to attach.",
    },
    {
      p: "We don't log what your tools read or return. A tool call waiting for your approval is stored encrypted until you answer it, and deleted after it expires if you don't. Otherwise tool data is kept only where you or an app save it, such as a workflow's history.",
    },
    { h2: "Why we use it" },
    {
      p: `We use your data to provide the service you signed up for, and, for security, error reports and usage counts, for our legitimate interest in running ${name} safely and reliably.`,
    },
    { h2: "Where it is stored" },
    {
      ul: [
        "Database: PlanetScale, in the EU (Frankfurt, eu-central).",
        "Files and app data: Cloudflare R2 and Durable Objects, restricted to the EU.",
        "Pool backend: Cloudflare Containers, restricted to the EU.",
        `${name} runs on Cloudflare's network, which handles requests at the location nearest to you.`,
      ],
    },
    { h2: "Who else receives data" },
    {
      ul: [
        `**Services you connect.** When you or your agent use a connected account, ${name} sends requests to that service with your access.`,
        "**Your AI agent.** Results from your tools go to the agent you connected, such as Claude Code, Codex or Cursor, and so to that agent's provider. Model requests through your pool go to the model provider whose subscription you connected.",
        `**Cloudflare** hosts ${name} and sends our emails (sign-in codes, invitations and verification links) from ${brand.emailDomain}.`,
        "**PlanetScale** hosts our database (EU).",
        "**Sentry** (EU) receives error reports and the feedback you send. Error reports contain an error code, the kind of page or request, and your account ID. They don't contain your content.",
        "**PostHog** (US) receives product usage events, such as signing up, connecting an account or calling a tool, with your account ID and, for some events, which app or service was involved. They contain no content, no email address and no IP address.",
        "**Google and GitHub**, if you choose them to sign in.",
      ],
    },
    {
      p: "Some of these recipients process data outside Switzerland and the EEA, including in the United States. Those transfers rely on the EU Standard Contractual Clauses. We don't sell your data and don't use it for advertising.",
    },
    { h2: "Google user data" },
    {
      p: `${name}'s use and transfer to any other app of information received from Google APIs will adhere to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.`,
    },
    {
      p: `When you connect a Google account, ${name} uses the Google data you allow (for example Gmail, Calendar, Drive, Docs, Sheets and Slides) only to carry out the requests you and your agents make, and returns the results to you and the agent you connected. We do not:`,
    },
    {
      ul: [
        "use Google user data for advertising, or sell it;",
        "use it to develop, improve or train generalized AI or machine learning models;",
        "let people read it, unless you ask us to, it is needed for security, or the law requires it.",
      ],
    },
    { h2: "Cookies" },
    {
      p: `${name} uses only cookies it needs to work: your sign-in session, the organization you last used, your time zone, and whether to show the passkey prompt. There are no advertising or analytics cookies.`,
    },
    { h2: "How long we keep it" },
    {
      ul: [
        "Your account, organizations and connected accounts: until you remove them or ask us to delete your account.",
        "Sessions: 7 days, or until you sign out.",
        "Inactive agent connections: revoked after 30 days.",
        "Pool usage counts: 30 days.",
        "Events apps send each other: 3 days.",
      ],
    },
    {
      p: `Disconnecting an account in ${name} deletes its stored tokens. To also end access at the service, revoke ${name} in that service's settings, for example your Google Account's third-party access page.`,
    },
    { h2: "Your choices and rights" },
    {
      p: `You can disconnect accounts, revoke sessions, remove members, and leave or delete an organization in ${name}. To get a copy of your data, correct it, or delete your account, write to ${email}. We may need to verify your identity before acting on a request.`,
    },
    {
      p: "You can complain to the Swiss Federal Data Protection and Information Commissioner (FDPIC) or, where EU law applies, your local supervisory authority.",
    },
    { h2: "Changes" },
    {
      p: "If we change this policy in a significant way, we will tell you by email or in the app before the change takes effect.",
    },
  ],
};

const terms: LegalPage = {
  path: "/terms",
  label: "Terms",
  title: "Terms of Service",
  summary: `The terms for using ${name}.`,
  blocks: [
    {
      p: `These terms apply to ${name} at ${brand.zone} and ${brand.host}. ${name} is operated by ${operator} ("we"). By creating an account or using ${name}, you agree to them.`,
    },
    { h2: "The service" },
    {
      p: `${name} lets you connect AI agents to apps and accounts you sign in to, and to model subscriptions you already have. It is an early service. Features can change, and it may be unavailable at times.`,
    },
    { h2: "Your account" },
    {
      ul: [
        `You need an account to use ${name}. Keep your sign-in methods and any keys or setup links ${name} gives you private.`,
        "You are responsible for what happens under your account, including actions your agents take through it.",
        "You must be old enough to agree to these terms where you live, and at least 16.",
      ],
    },
    { h2: "Your connected accounts and subscriptions" },
    {
      ul: [
        `When you connect a service such as Google, GitHub or Slack, or a model subscription, you allow ${name} to use it on your behalf with the access you grant. You can disconnect it at any time.`,
        "You must follow the terms of each service you connect. Your organization's policies, or the service itself, may limit or block access. We don't control that.",
        "Agents can take real actions, such as sending messages or changing files. Some actions ask for your approval first. You are responsible for the actions you allow.",
      ],
    },
    { h2: "Acceptable use" },
    {
      p: `Don't use ${name} to break the law, harm others, send spam, get around another service's limits or security, access accounts you aren't allowed to use, or attack or overload ${name}.`,
    },
    { h2: "Your content" },
    {
      p: `Your data stays yours. We use it only to run ${name} for you, as described in the [Privacy Policy](/privacy).`,
    },
    { h2: "Ending your use" },
    {
      p: `You can stop using ${name} and ask us to delete your account at any time by writing to ${email}. We may suspend or close accounts that break these terms or put the service or others at risk. Where we reasonably can, we will tell you first.`,
    },
    { h2: "No warranty" },
    {
      p: `${name} is provided "as is" and "as available", without warranties of any kind, to the extent the law allows.`,
    },
    { h2: "Limitation of liability" },
    {
      p: "To the extent the law allows, we are not liable for indirect or consequential losses, or for losses caused by third-party services you connect. Nothing in these terms limits liability that cannot be limited by law.",
    },
    { h2: "Changes" },
    {
      p: "We may update these terms. If a change is significant, we will tell you before it takes effect, by email or in the app.",
    },
    { h2: "Law" },
    {
      p: "These terms are governed by Swiss law. The courts of Zurich, Switzerland have jurisdiction, unless mandatory law lets you bring a claim where you live.",
    },
    { h2: "Contact" },
    { p: email },
  ],
};

const legalNotice: LegalPage = {
  path: "/legal-notice",
  label: "Legal notice",
  title: "Legal notice",
  summary: `Who operates ${brand.zone} and how to reach us.`,
  blocks: [
    { h2: "Operator" },
    { lines: [site.operator, site.region, email] },
    { h2: "More information" },
    {
      p: "How we handle your data is in the [Privacy Policy](/privacy), and the rules for using the service are in the [Terms of Service](/terms).",
    },
  ],
};

export const legalPages: readonly LegalPage[] = [privacy, terms, legalNotice];
