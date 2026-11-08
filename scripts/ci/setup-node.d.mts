export function nodeAsset(
  version: string,
  platform?: string,
): {
  url: string;
  integrity: string;
  key: string;
  file: string;
};
export function installNode(version: string, root: string): string;
