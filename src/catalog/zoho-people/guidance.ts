const regions = [
  { method: "oauthEu", label: "Europe (EU)", console: "https://api-console.zoho.eu/" },
  { method: "oauthUs", label: "United States (US)", console: "https://api-console.zoho.com/" },
  { method: "oauthIn", label: "India (IN)", console: "https://api-console.zoho.in/" },
];

export const peopleConnectionGuidance = [
  ...regions.map((region) => ({
    requirement: "people",
    method: region.method,
    signIn: {
      description: `Connect your Zoho People account in ${region.label}.`,
      note: "This app can read and change HR records, attendance, leave and time tracking with your account's permissions. Writes require approval. Your Zoho plan and administrator still control access.",
      details:
        "The core API requests attendance.ALL, leave.ALL, employee.ALL and payroll.ALL where the documented APIs require module-wide access; forms.READ, CREATE and UPDATE; and timetracker.READ, CREATE, UPDATE and DELETE. These are Zoho People scopes only. Choose the data center shown in your Zoho People address before signing in. There is no automatic data-center routing. Your chosen region is used for sign-in and every API call.",
    },
    oauthClient: {
      steps: [
        "Open the Zoho API Console using a developer account you control and choose Server-based Applications.",
        "Register a client, or open one you already own. Add the exact redirect URI shown here to Authorized Redirect URIs.",
        "For a client serving several data centers, enable them in Settings and choose Use the same OAuth credentials for all data centers.",
        "Copy the client ID and client secret from Client Secret into the fields below, then continue to Zoho sign-in.",
      ],
      link: { label: `Open Zoho API Console (${region.label})`, url: region.console },
      note: "Use a client registered by you or your app's owner. Connecting an employer's People account does not require creating or changing anything inside the employer's tenant.",
      fields: {
        clientId: {
          label: "Zoho client ID",
          expectedFormat: "The client ID shown by the Zoho API Console.",
        },
        clientSecret: {
          label: "Zoho client secret",
          expectedFormat: "The client secret for the selected data center.",
        },
      },
    },
  })),
  {
    requirement: "people",
    method: "mcp",
    signIn: {
      description: "Grant access to the tools enabled on your Zoho MCP server.",
      note: "Your organisation must enable Zoho MCP. Use a REST account if it does not. Tools without an explicit read-only hint require approval.",
      details:
        "Sign-in is discovered from this server. It does not use the Zoho People REST client. The enabled MCP tools can differ from the REST API tools.",
    },
    credentials: {
      steps: [
        "Open the Zoho MCP console for your data center: mcp.zoho.eu, mcp.zoho.com or mcp.zoho.in.",
        "Use an existing server or create one with the People tools you need, only if your organisation allows it.",
        "Copy the complete private server URL from its connection details and paste it below, then continue to Zoho sign-in.",
      ],
      link: {
        label: "Read Zoho MCP setup instructions",
        url: "https://help.zoho.com/portal/en/kb/mcp/implementation-guide/articles/zoho-mcp-implementation-guide",
      },
      note: "This URL is a credential. Keep it out of app source and chat.",
    },
  },
];
