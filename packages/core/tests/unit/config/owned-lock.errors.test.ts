/**
 * SMI-7148: thrownText and thrownCode must be total. The release paths build
 * their warnings with them inside callers' `finally` blocks, so a hostile
 * thrown value (a revoked proxy, a throwing getter) must not make formatting
 * throw.
 */
import { describe, expect, it } from 'vitest'

import { thrownCode, thrownText } from '../../../src/config/owned-lock.errors.js'

function revokedProxy(): unknown {
  const { proxy, revoke } = Proxy.revocable({}, {})
  revoke()
  return proxy
}

function withThrowingGetter(prop: 'message' | 'code'): unknown {
  const err = new Error('placeholder')
  Object.defineProperty(err, prop, {
    get() {
      throw new Error(`${prop} getter throws`)
    },
  })
  return err
}

describe('thrownText', () => {
  it('returns an Error message, and a fixed string for a non-Error', () => {
    expect(thrownText(new Error('boom'))).toBe('boom')
    expect(thrownText('a string')).toBe('not an Error')
    expect(thrownText(null)).toBe('not an Error')
  })

  it('a revoked proxy (instanceof throws) gives a fixed string, never a throw', () => {
    expect(() => revokedProxy() instanceof Error).toThrow() // control: the hazard is real
    expect(thrownText(revokedProxy())).toBe('an unreadable thrown value')
  })

  it('an Error whose message getter throws gives a fixed string, never a throw', () => {
    expect(thrownText(withThrowingGetter('message'))).toBe('an unreadable thrown value')
  })
})

describe('thrownCode', () => {
  it('returns an errno code, and falls back to the text without one', () => {
    const e = Object.assign(new Error('nope'), { code: 'EACCES' })
    expect(thrownCode(e)).toBe('EACCES')
    expect(thrownCode(new Error('no code'))).toBe('no code')
    expect(thrownCode(undefined)).toBe('not an Error')
  })

  it('a throwing code getter or a revoked proxy never throws', () => {
    expect(thrownCode(withThrowingGetter('code'))).toBe('placeholder')
    expect(thrownCode(revokedProxy())).toBe('an unreadable thrown value')
  })
})
