/**
 * SMI-595: confusables.ts — extraction sanity tests.
 *
 * The real regression guard for "this extraction changed no behavior" is
 * `SecurityScanner.exec.test.ts` passing unchanged (it exercises these
 * primitives indirectly through `scanObfuscatedDirective`). These tests cover
 * the extracted module directly, in isolation from content-scanning.
 */

import { describe, it, expect } from 'vitest'
import {
  CONFUSABLES,
  isFullwidthLatin,
  isMathAlphanumeric,
  confusableSkeleton,
} from './confusables.js'

describe('confusables — extraction sanity (SMI-595)', () => {
  it('maps known Cyrillic homoglyphs to their Latin look-alike', () => {
    expect(CONFUSABLES['а']).toBe('a') // Cyrillic а (U+0430)
    expect(CONFUSABLES['е']).toBe('e') // Cyrillic е (U+0435)
    expect(CONFUSABLES['о']).toBe('o') // Cyrillic о (U+043E)
  })

  it('maps known Greek homoglyphs to their Latin look-alike', () => {
    expect(CONFUSABLES['ο']).toBe('o')
    expect(CONFUSABLES['α']).toBe('a')
  })

  it('identifies fullwidth Latin code points', () => {
    expect(isFullwidthLatin('ａ'.codePointAt(0)!)).toBe(true) // fullwidth 'a'
    expect(isFullwidthLatin('a'.codePointAt(0)!)).toBe(false) // ordinary ascii 'a'
  })

  it('identifies Mathematical Alphanumeric Symbols code points', () => {
    expect(isMathAlphanumeric(0x1d400)).toBe(true) // start of the block
    expect(isMathAlphanumeric(0x1d7ff)).toBe(true) // end of the block
    expect(isMathAlphanumeric(0x0061)).toBe(false) // ascii 'a'
  })

  it('confusableSkeleton folds Cyrillic homoglyphs to ASCII', () => {
    expect(confusableSkeleton('аnthropic')).toBe('anthropic') // Cyrillic а
  })

  it('confusableSkeleton folds fullwidth Latin to ASCII by offset', () => {
    expect(confusableSkeleton('ｈｅｌｌｏ')).toBe('hello')
  })

  it('confusableSkeleton leaves plain ASCII untouched', () => {
    expect(confusableSkeleton('anthropic-community-tools')).toBe('anthropic-community-tools')
  })

  it('confusableSkeleton leaves benign CJK untouched (no blanket NFKC)', () => {
    const cjk = '全角文字のテスト'
    expect(confusableSkeleton(cjk)).toBe(cjk)
  })
})
