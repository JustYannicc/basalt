import { exactVersion } from "./source.mjs";

export const limits = Object.freeze({
  sourceFiles: 4096,
  sourceBytes: 16 * 1024 * 1024,
  publicFiles: 10000,
  publicFileBytes: 32_000_000,
  publicBytes: 1_000_000_000,
});

export function checkManifest(files, version) {
  const errors = [];
  const paths = new Set();
  let sourceFiles = 0,
    sourceBytes = 0,
    publicFiles = 0,
    publicBytes = 0;
  for (const file of files) {
    if (
      typeof file.path !== "string" ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      errors.push("source-path: app files need safe relative paths");
      continue;
    }
    if (paths.has(file.path)) errors.push(`source-path: duplicate ${file.path}`);
    paths.add(file.path);
    if (file.path.startsWith("ui/public/")) {
      publicFiles++;
      const size = file.size ?? file.bytes.length;
      publicBytes += size;
      if (size > limits.publicFileBytes)
        errors.push(`public-file-size: ${file.path} exceeds 32 MB`);
    } else {
      sourceFiles++;
      sourceBytes += file.bytes.length;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch {
        errors.push(`source-utf8: ${file.path} must be UTF-8 text outside ui/public/`);
      }
      if (file.bytes.includes(0))
        errors.push(`source-utf8: ${file.path} contains binary NUL bytes`);
    }
  }
  for (const path of paths) {
    const parts = path.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/"))) errors.push(`source-path: ${path} has a file as its parent`);
      parts.pop();
    }
  }
  if (sourceFiles > limits.sourceFiles) errors.push("source-file-count: exceeds 4096 files");
  if (sourceBytes > limits.sourceBytes) errors.push("source-size: exceeds 16 MiB");
  if (publicFiles > limits.publicFiles) errors.push("public-file-count: exceeds 10000 files");
  if (publicBytes > limits.publicBytes) errors.push("public-total-size: exceeds 1 GB");
  if (!paths.has("index.ts")) errors.push("default-app-export: missing index.ts");
  const manifest = files.find((file) => file.path === "package.json");
  if (!manifest) errors.push("manifest-module: missing package.json");
  else {
    try {
      const value = JSON.parse(manifest.bytes.toString("utf8"));
      if (value.type !== "module")
        errors.push("manifest-module: package.json must set type to module");
      const pin = value.dependencies?.apps;
      if (!exactVersion(pin))
        errors.push("framework-pin: dependencies.apps must be an exact version");
      else if (pin !== version)
        errors.push(`framework-pin: expected prepared host ${version}, found ${pin}`);
    } catch {
      errors.push("manifest-module: invalid package.json");
    }
  }
  return errors;
}
