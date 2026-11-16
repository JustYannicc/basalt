import type * as Cloudflare from "alchemy/Cloudflare";

// Alchemy beta.80 forwards these Cloudflare API fields but omits them from its type.
// https://developers.cloudflare.com/containers/concepts/placement/
export const euPlacement: Cloudflare.ContainerApplication.Constraints & {
  jurisdiction: "eu";
  regions: ("EEUR" | "WEUR")[];
} = { jurisdiction: "eu", regions: ["EEUR", "WEUR"] };
