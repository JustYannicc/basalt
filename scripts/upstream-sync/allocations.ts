export const syncCarryNumbers = {
  prelude: "0448",
  cloudBridge: "0475",
  protocolFramework: "0476",
} as const;

// Basalt releases its page protocols before adopting v2's upstream protocol 42.
export const syncProtocolMappings = [
  {
    boundary: "credentialHostsProtocol",
    upstream: {
      firstCommit: "2f4c398f3906e0570f0e25a16fa3602329baba29",
      number: 42,
    },
    basalt: 44,
    retained: { appPagesProtocol: 42, appPageSearchProtocol: 43 },
  },
] as const;
