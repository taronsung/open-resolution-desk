// canonical.js - canonical JSON and SHA-256 helpers for the Open Resolution
// protocol (ord/1). Both parties hash the same canonical text, so a hash names
// the same content in every browser and in Node.
//
// Canonical form: object keys sorted by UTF-16 code unit order, no whitespace,
// strings and integers as JSON.stringify writes them. Floats, NaN, Infinity,
// undefined, functions and symbols are rejected: amounts are integer cents.

/**
 * Return the canonical JSON text of a plain JSON value.
 *
 * :param value: A JSON value made of objects, arrays, strings, integers,
 *   booleans and null.
 * :return: The canonical text.
 * :raises TypeError: When the value holds anything else.
 */
export function canonicalize(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`Canonical JSON allows safe integers only, got ${value}.`);
      }
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError("Canonical JSON allows plain objects only.");
      }
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const key of keys) {
        if (value[key] === undefined) {
          throw new TypeError(`Canonical JSON does not allow undefined (key "${key}").`);
        }
        parts.push(`${JSON.stringify(key)}:${canonicalize(value[key])}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new TypeError(`Canonical JSON does not allow ${typeof value}.`);
  }
}

/**
 * Return the lowercase hex SHA-256 digest of a text, using Web Crypto.
 *
 * :param text: The text to hash; it is encoded as UTF-8.
 * :return: 64 hex characters.
 */
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Hash a JSON value through its canonical text.
 *
 * :param value: A JSON value (see canonicalize).
 * :return: "sha256:" followed by 64 hex characters.
 */
export async function hashOf(value) {
  return `sha256:${await sha256Hex(canonicalize(value))}`;
}

/**
 * Shorten a "sha256:..." hash for display, such as "sha256:3f9a…c21e".
 *
 * :param hash: A hash string from hashOf.
 * :return: The short form, or the input when it is not a hash string.
 */
export function shortHash(hash) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(hash || ""));
  if (!match) return String(hash || "");
  return `sha256:${match[1].slice(0, 4)}…${match[1].slice(-4)}`;
}
