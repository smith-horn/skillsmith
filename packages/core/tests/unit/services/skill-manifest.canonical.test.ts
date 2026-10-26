/**
 * SMI-6531 (A1 step 7a): the canonical form the manifest CAS compares.
 *
 * Every "equal" row sits beside a "different" row, so a `canonicalJson` that
 * returned one constant string would fail the second.
 */
import { describe, expect, it } from 'vitest'
import {
  canonicalize,
  canonicalJson,
  isPlainObject,
} from '../../../src/services/skill-manifest.canonical.js'

describe('canonicalJson', () => {
  it('sorts object keys at every depth and leaves arrays in order', () => {
    const a = { z: 1, a: { y: [3, { q: 1, b: 2 }], c: null } }
    const b = { a: { c: null, y: [3, { b: 2, q: 1 }] }, z: 1 }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"y":[3,{"b":2,"q":1}]},"z":1}')
    expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }))
  })

  it('null stays null and an absent key stays absent', () => {
    expect(canonicalJson({ a: null })).toBe('{"a":null}')
    expect(canonicalJson({})).toBe('{}')
    expect(canonicalJson({ a: null })).not.toBe(canonicalJson({}))
  })

  it('sorts keys in code-unit order, not locale order', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3 })).toBe('{"B":2,"a":3,"b":1}')
  })

  it('keeps a key named __proto__ as an own key, and does not let it change the prototype', () => {
    const raw = JSON.parse('{"__proto__":{"x":1},"a":1}') as Record<string, unknown>
    const out = canonicalize(raw) as Record<string, unknown>
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(canonicalJson(raw)).toBe('{"__proto__":{"x":1},"a":1}')
    expect(canonicalJson(raw)).not.toBe(canonicalJson({ a: 1 }))
  })

  it('returns a deep copy', () => {
    const src = { a: { b: [1] } }
    const out = canonicalize(src) as { a: { b: number[] } }
    expect(out).toEqual(src)
    expect(out.a).not.toBe(src.a)
    expect(out.a.b).not.toBe(src.a.b)
  })

  it('throws on a value JSON cannot hold, where it accepts the neighbouring JSON value', () => {
    const bad: unknown[] = [
      undefined,
      () => 1,
      Symbol('s'),
      10n,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { a: undefined },
      [undefined],
    ]
    for (const v of bad) expect(() => canonicalize(v), String(v)).toThrow(TypeError)
    for (const ok of [null, 0, -1.5, '', false, [], {}]) {
      expect(() => canonicalize(ok)).not.toThrow()
    }
  })
})

describe('isPlainObject', () => {
  it('accepts what JSON.parse yields and refuses arrays, null, class instances and primitives', () => {
    expect(isPlainObject(JSON.parse('{"a":1}'))).toBe(true)
    expect(isPlainObject(Object.create(null))).toBe(true)
    for (const v of [null, [], new Date(), new Map(), 'x', 1, undefined]) {
      expect(isPlainObject(v)).toBe(false)
    }
  })
})
