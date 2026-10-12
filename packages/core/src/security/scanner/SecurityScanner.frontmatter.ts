/**
 * Security Scanner — executable frontmatter detector (SMI-7030)
 * @module @skillsmith/core/security/scanner/SecurityScanner.frontmatter
 *
 * gray-matter 4.0.3 (used by @skillsmith/cli <= 0.8.13's `import-local`) evals a
 * frontmatter block whose opener names the `js` / `javascript` engine. This
 * detector is STRUCTURAL: it looks only at the opener, never at the payload
 * (which is arbitrary JavaScript). Flag-only: the finding carries a category
 * weight for reporting but a risk-score coefficient of exactly 0.
 *
 * Never routed through context classification: the markdown context model only
 * recognises a bare `---` opener, so a `---js` block would be misclassified.
 */

import type { SecurityFinding } from './types.js'

/**
 * Mirrors gray-matter 4.0.3 opener + language detection
 * (index.js:69-90,205-217; engine.js). Deliberately omits gray-matter's
 * `charAt(3) === '-'` guard: it is an equivalent mutant, since a `-`-led
 * remainder can never equal `js` / `javascript`. Do NOT reuse the 0.8.14 CLI
 * `OPENER` regex, which misses inputs gray-matter evaluates.
 */
export function opensWithExecutableFrontmatter(content: string): boolean {
  const s = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content // strip-bom-string: one BOM
  if (!s.startsWith('---')) return false
  const rest = s.slice(3)
  const name = rest.slice(0, rest.search(/\r?\n/)).trim().toLowerCase() // -1 -> slice(0,-1), as gray-matter
  return name === 'js' || name === 'javascript'
}

/** Emits at most one finding, for the outer document only. */
export function scanExecutableFrontmatter(content: string): SecurityFinding[] {
  if (!opensWithExecutableFrontmatter(content)) return []
  return [
    {
      type: 'executable_frontmatter',
      severity: 'critical',
      confidence: 'high',
      lineNumber: 1,
      message:
        'frontmatter opens with an executable "---js" / "---javascript" block; ' +
        'gray-matter-based parsers (@skillsmith/cli <= 0.8.13 import-local) evaluate it as code',
      location: 'line 1',
    },
  ]
}
