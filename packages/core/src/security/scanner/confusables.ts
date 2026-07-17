/**
 * Confusable / homoglyph normalization primitives
 * @module @skillsmith/core/security/scanner/confusables
 *
 * SMI-595: extracted from `SecurityScanner.exec.ts` (originally built there
 * under SMI-5359 Wave 4.2 for *content* obfuscation detection) so the
 * name-agnostic folding primitives can be reused for *skill-name* typosquat
 * comparison (`typosquat.ts`) without coupling it to the code-execution /
 * obfuscated-directive detectors. Pure extraction — no behavior change:
 * `SecurityScanner.exec.ts` re-imports these symbols and its own test suite
 * (`SecurityScanner.exec.test.ts`) passes unchanged.
 */

/**
 * Conservative homoglyph map (a curated subset of UTS-#39 confusables): only the
 * unambiguous Cyrillic / Greek look-alikes that real homoglyph attacks use to
 * disguise Latin letters. Fullwidth Latin (offset 0xFEE0) and the Mathematical
 * Alphanumeric Symbols block (U+1D400-1D7FF, e.g. bold/italic/script 𝐢𝐠𝐧𝐨𝐫𝐞)
 * are handled programmatically below — never via a blanket NFKC pass, which would
 * also fold fullwidth CJK to ASCII and false-positive. (NFKC is applied per-char
 * ONLY to the math-alphanumeric range, which contains no CJK.)
 */
export const CONFUSABLES: Record<string, string> = {
  // Cyrillic -> Latin
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  һ: 'h',
  к: 'k',
  м: 'm',
  т: 't',
  в: 'b',
  н: 'h',
  // Greek -> Latin
  ο: 'o',
  α: 'a',
  ρ: 'p',
  ε: 'e',
  τ: 't',
  ι: 'i',
  κ: 'k',
  υ: 'u',
  χ: 'x',
  ν: 'v',
  ϲ: 'c',
  β: 'b',
}

export function isFullwidthLatin(cp: number): boolean {
  return (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a)
}

/** Mathematical Alphanumeric Symbols (bold/italic/script/fraktur/double-struck/sans/mono). */
export function isMathAlphanumeric(cp: number): boolean {
  return cp >= 0x1d400 && cp <= 0x1d7ff
}

/** Map homoglyphs + fullwidth Latin + math-alphanumeric to their ASCII skeleton. */
export function confusableSkeleton(s: string): string {
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    if (isFullwidthLatin(cp)) {
      out += String.fromCodePoint(cp - 0xfee0)
    } else if (isMathAlphanumeric(cp)) {
      // NFKC folds a math-styled glyph to its base; chain through CONFUSABLES so a
      // math-styled Greek/Cyrillic homoglyph (folds to Greek/Cyrillic) still maps
      // to Latin (SMI-5359 retro NIT). Safe: the range contains no CJK; a reserved
      // hole stays unchanged (won't match).
      const folded = ch.normalize('NFKC')
      out += CONFUSABLES[folded] ?? folded
    } else if (CONFUSABLES[ch]) {
      out += CONFUSABLES[ch]
    } else {
      out += ch
    }
  }
  return out
}
