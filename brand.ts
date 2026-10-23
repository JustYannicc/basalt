export const brand = {
  name: "Signalbox",
  host: "app.signalbox.run",
  zone: "signalbox.run",
  emailDomain: "auth.signalbox.run",
} as const;

export const deployment = {
  stage: "production",
  sourceNamespace: "basalt-production-apps",
  databaseName: "basalt",
  databaseRegion: "eu-central",
  databaseClusterSize: "PS_5",
  placementRegion: "aws:eu-central-1",
} as const;

export const appHosting = {
  enabled: false,
  origin: "https://apps.signalbox.run",
  zone: "signalbox.run",
} as const;
