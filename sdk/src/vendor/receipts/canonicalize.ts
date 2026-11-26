/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * - Object members are sorted by their names compared as UTF-16 code units
 *   (JavaScript's default string ordering, which is what RFC 8785 §3.2.3 specifies).
 * - Strings and numbers are serialized exactly as ECMAScript's JSON.stringify does
 *   (RFC 8785 §3.2.2 adopts that serialization), with no insignificant whitespace.
 * - Non-finite numbers, lone surrogates, and values JSON cannot represent are errors,
 *   never silently dropped or coerced.
 *
 * Members whose value is `undefined` are skipped, matching JSON.stringify, so an object
 * built in code canonicalizes the same way as the JSON it would be sent as.
 */
export class CanonicalizationError extends Error {
  constructor(message: string, readonly path: string) {
    super(`${path || "<root>"}: ${message}`);
    this.name = "CanonicalizationError";
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, "");
}

function serialize(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalizationError("non-finite number", path);
      return JSON.stringify(value);
    case "string":
      if (!value.isWellFormed()) throw new CanonicalizationError("string contains a lone surrogate", path);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        // An index loop, not map(): map() skips holes, so a sparse array would serialize as
        // "[1,,3]", which is not JSON. A hole reads as undefined here and is rejected like one.
        const items: string[] = [];
        for (let index = 0; index < value.length; index++) {
          const item: unknown = value[index];
          if (item === undefined) throw new CanonicalizationError("undefined array element", `${path}[${index}]`);
          items.push(serialize(item, `${path}[${index}]`));
        }
        return `[${items.join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalizationError("only plain objects can be canonicalized", path);
      }
      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        if (member === undefined) continue;
        if (!key.isWellFormed()) throw new CanonicalizationError("member name contains a lone surrogate", path);
        members.push(`${JSON.stringify(key)}:${serialize(member, path ? `${path}.${key}` : key)}`);
      }
      return `{${members.join(",")}}`;
    }
    default:
      throw new CanonicalizationError(`cannot canonicalize a ${typeof value}`, path);
  }
}
