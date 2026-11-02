import { createHmac } from "node:crypto";

export const stage = "scale-180";
export const prefix = "basalt-180-scale";
export const candidate = "f8213cfd9957fa7cf467c56035ce3dac96438b3c";
export const imageDigest = "sha256:6a0432480ae39e91ac3f574f020805ce8c3a3e4786ded7b6c809a17be339ab7c";
export const database = `${prefix}-pg`;
export const worker = `${prefix}-gateway`;
export const sizes = ["lite", "basic", "standard-2"];
export function validate(env = process.env) {
  if (env.SCALE_STAGE !== stage) throw new Error("Only scale-180 is allowed");
  if (!["deploy", "run", "destroy", "validate"].includes(env.SCALE_MODE ?? "")) throw new Error("Unknown scale-test mode");
  if (env.GITHUB_ACTIONS !== "true") throw new Error("Scale operations run only in GitHub Actions");
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Scale operations require main");
}
export function credentials() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token) throw new Error("Missing Cloudflare credential");
  const derive = (name: string) => createHmac("sha256", token).update(`${prefix}:${name}`).digest("hex");
  return { admin: derive("admin"), management: derive("management"), signing: derive("signing"), seed: derive("seed") };
}
