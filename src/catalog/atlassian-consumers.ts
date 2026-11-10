import jira from "./jira.json" with { type: "json" };
import confluence from "./confluence.json" with { type: "json" };

/** Separate tools share the host's reviewed Atlassian sign-in, as Google apps do. */
export const atlassianConsumers = { jira, confluence };
