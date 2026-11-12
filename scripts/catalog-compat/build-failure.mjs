const compilerPrefix = "Browser compilation returned invalid outputs or unresolved imports.";
const importsPrefix = `${compilerPrefix} Unresolved imports: `;
const moduleSpecifier =
  /^(?:#[A-Za-z0-9_][A-Za-z0-9._-]*|(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

/** Only the compiler's canonical diagnostic and public module-name syntax may leave the run. */
export function compilerDiagnostic(message) {
  if (typeof message !== "string" || message.length > 2048) return undefined;
  if (message === compilerPrefix) return message;
  if (!message.startsWith(importsPrefix)) return undefined;
  const encoded = message.slice(importsPrefix.length);
  try {
    const imports = JSON.parse(encoded);
    if (
      !Array.isArray(imports) ||
      imports.length === 0 ||
      imports.length > 32 ||
      !imports.every(
        (specifier) =>
          typeof specifier === "string" &&
          specifier.length <= 160 &&
          moduleSpecifier.test(specifier),
      ) ||
      JSON.stringify([...new Set(imports)].sort()) !== encoded
    )
      return undefined;
    return message;
  } catch {
    return undefined;
  }
}

export function catalogBuildFailure(body, status) {
  const compilerMessage = compilerDiagnostic(body.message);
  return {
    text: `${body._tag ?? status}${body.stage ? ` at ${body.stage}` : ""}: ${String(body.message ?? "").slice(0, 300)}`,
    tag: typeof body._tag === "string" ? body._tag : String(status),
    ...(typeof body.stage === "string" ? { stage: body.stage } : {}),
    ...(compilerMessage === undefined ? {} : { compilerMessage }),
  };
}
