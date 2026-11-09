import { Database } from "alchemy/Cloudflare/D1";
import { retain } from "alchemy/RemovalPolicy";

const id = "PublicSiteWaitlist";

export const provisionPublicSiteWaitlist = Database(id, {
  name: "public-site-waitlist",
  jurisdiction: "eu",
}).pipe(retain());

/** Binding a consumer does not register a second database or change its reviewed intent. */
export const publicSiteWaitlist = Database.ref(id);
