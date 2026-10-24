/** Parse JSON while rejecting repeated object keys before JSON.parse can overwrite them. */
export function parseJsonRejectingDuplicateKeys(source: string): unknown {
  let offset = 0;

  const skipWhitespace = () => {
    while (/\s/.test(source[offset] ?? "")) offset++;
  };

  const parseString = (): string => {
    const start = offset;
    if (source[offset] !== '"') throw new SyntaxError("Expected a JSON string");
    offset++;
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === "\\") {
        offset++;
        continue;
      }
      if (character === '"') return JSON.parse(source.slice(start, offset)) as string;
      if (character < " ") throw new SyntaxError("Invalid control character in JSON string");
    }
    throw new SyntaxError("Unterminated JSON string");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      offset++;
      skipWhitespace();
      if (source[offset] === "}") {
        offset++;
        return;
      }
      const keys = new Set<string>();
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (source[offset++] !== ":") throw new SyntaxError("Expected a colon after a JSON object key");
        parseValue();
        skipWhitespace();
        const separator = source[offset++];
        if (separator === "}") return;
        if (separator !== ",") throw new SyntaxError("Expected a comma or closing brace in JSON object");
      }
    }
    if (character === "[") {
      offset++;
      skipWhitespace();
      if (source[offset] === "]") {
        offset++;
        return;
      }
      while (true) {
        parseValue();
        skipWhitespace();
        const separator = source[offset++];
        if (separator === "]") return;
        if (separator !== ",") throw new SyntaxError("Expected a comma or closing bracket in JSON array");
      }
    }
    if (character === '"') {
      parseString();
      return;
    }

    const start = offset;
    while (offset < source.length && !/[\s,}\]]/.test(source[offset]!)) offset++;
    if (start === offset) throw new SyntaxError("Expected a JSON value");
    JSON.parse(source.slice(start, offset));
  };

  parseValue();
  skipWhitespace();
  if (offset !== source.length) throw new SyntaxError("Unexpected content after JSON value");
  return JSON.parse(source) as unknown;
}
