/**
 * Sets each defined value and removes each undefined one. Assigning undefined onto process.env
 * stores the text "undefined", which a Worker binding then carries as a real setting.
 */
export function assignEnvironment(
  target: Record<string, string | undefined>,
  values: Readonly<Record<string, string | undefined>>,
) {
  for (const [name, value] of Object.entries(values))
    if (value === undefined) delete target[name];
    else target[name] = value;
}
