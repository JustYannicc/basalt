export interface SetupBrand {
  name: string;
  mcpServerName: string;
  setup: { id: string; marker: string };
}
export interface SetupCredentials {
  modelUrl?: string;
  modelKey?: string;
  toolsUrl?: string;
  toolsToken?: string;
}
export type SetupClients = Partial<Record<"claude" | "codex", SetupCredentials | "keep" | null>>;
export interface SetupOptions {
  home: string;
  env?: Record<string, string | undefined>;
  brand: SetupBrand;
  credentials?: SetupCredentials;
  clients?: SetupClients;
  undo?: boolean;
  expectedRevision?: string;
}
export interface ConfigurationPreview {
  revision: string;
  configured: { claude: boolean; codex: boolean };
  files: Array<{
    kind: string;
    path: string;
    action: "update" | "restore" | "keep";
    fields: string[];
  }>;
}
export function configPaths(
  home: string,
  env: Record<string, string | undefined>,
): Array<{ kind: string; path: string; format: string }>;
export function previewConfiguration(options: SetupOptions): Promise<ConfigurationPreview>;
export function configure(options: SetupOptions): Promise<void>;
