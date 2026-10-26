/**
 * SMI-6531 (A1 step 7a): the canonical form the manifest CAS compares (A1 plan
 * §3.6, PLAN:1747-1749).
 *
 * The form is taken over the raw `JSON.parse` value, before any coercion or
 * defaulting: object keys are sorted in code-unit order at every depth, arrays
 * keep their order, `null` stays `null`, and an absent key stays absent. So two
 * documents that differ only in the key order they were written in compare
 * equal, and `null` versus absent, or one reordered array, compare different.
 *
 * A value JSON cannot hold (`undefined`, a function, a symbol, a bigint or a
 * non-finite number) throws instead of being serialized as text such as
 * `undefined`, which would let two different values compare equal. Raw
 * manifest values never contain one.
 *
 * @module @skillsmith/core/services/skill-manifest.canonical
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** A deep copy of `value` with every object's keys sorted and arrays left in order. */
export function canonicalize(value: unknown): JsonValue {
  if (value === null) return null
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalize: ${String(value)} is not a JSON value`)
      }
      return value
    case 'object':
      break
    default:
      throw new TypeError(`canonicalize: a ${typeof value} is not a JSON value`)
  }
  if (Array.isArray(value)) return value.map((item) => canonicalize(item))
  const source = value as Record<string, unknown>
  const out: JsonObject = {}
  for (const key of Object.keys(source).sort()) {
    // defineProperty, not assignment: a key named `__proto__` must stay an own property.
    Object.defineProperty(out, key, {
      value: canonicalize(source[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return out
}

/** The string the CAS compares: `JSON.stringify` of the canonical form. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** A non-null, non-array object with the ordinary or no prototype (what `JSON.parse` yields). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}
